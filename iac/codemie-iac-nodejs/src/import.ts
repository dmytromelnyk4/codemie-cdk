/*
 * Copyright © 2025 EPAM Systems, Inc. All Rights Reserved. All information contained herein is, and remains the
 * property of EPAM Systems, Inc. and/or its suppliers and is protected by international intellectual
 * property law. Dissemination of this information or reproduction of this material is strictly forbidden,
 * unless prior written permission is obtained from EPAM Systems, Inc
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Assistant, CodeMieClient, DataSource, SkillCompanionFile, SkillDetail, Workflow } from 'codemie-sdk';
import * as yaml from 'yaml';

import type { AppConfig } from './appConfig';
import { calculateChecksum } from './lib/checksumUtils';
import { createClient } from './lib/clientFactory';
import { calculateSkillConfigChecksum, calculateWorkflowConfigChecksum } from './lib/codemieConfigChecksums';
import { CodemieConfigLoader } from './lib/codemieConfigLoader';
import type { ResourceDefinition } from './lib/configImports';
import { findResourceDefinition } from './lib/configImports';
import { PAGINATION, TIMEOUTS_MS } from './lib/constants';
import {
  assistantResponseToResource,
  datasourceResponseToResource,
  skillResponseToResource,
  workflowResponseToResource,
} from './lib/converters';
import {
  ensureDirectoryExists,
  resolvePathWithinDirectory,
  sanitizeFileName,
  skillFlatFileRelativePath,
  skillMarkdownRelativePath,
} from './lib/fileUtils';
import { logger } from './lib/logger';
import { namesEqual } from './lib/nameUtils';
import type { ImportResourceType } from './lib/resourceTypes';
import { pluralTypeOf, VALID_RESOURCE_TYPES } from './lib/resourceTypes';
import { createConcurrentLimiter } from './lib/rateLimitUtils';
import { hasCompanionFileLayout } from './lib/skillCompanionFiles';
import { isProjectOwnedSkill } from './lib/skillUtils';
import { StateManager } from './lib/stateManager';
import { withTimeout } from './lib/timeoutUtils';
import type {
  AssistantResource,
  AssistantWithSkills,
  CodemieConfig,
  DatasourceResource,
  ImportedResource,
  SkillResource,
  StateFile,
  WorkflowResource,
} from './types/codemieConfig';

export type { ImportResourceType };
export { VALID_RESOURCE_TYPES };

export interface ImportOptions {
  appConfig: AppConfig;
  resourceType: ImportResourceType;
  slug: string;
  update?: boolean;
  /**
   * Assistants only: also import every referenced project-owned skill that the configuration
   * does not manage yet, so a freshly imported assistant deploys without a manual skill import.
   */
  withSkills?: boolean;
}

/**
 * Find an assistant by slug or name.
 * Tries getBySlug first, then falls back to list + filter by name.
 */
async function findAssistant(client: CodeMieClient, slug: string): Promise<Assistant> {
  // If caller supplied a raw UUID, skip slug/name search entirely.
  if (UUID_RE.test(slug)) {
    return withTimeout(
      client.assistants.get(slug),
      TIMEOUTS_MS.ASSISTANT_FETCH,
      `Timeout fetching assistant "${slug}"`
    );
  }

  // Try slug-based lookup first
  try {
    const assistant = await withTimeout(
      client.assistants.getBySlug(slug),
      TIMEOUTS_MS.ASSISTANT_FETCH,
      `Timeout fetching assistant by slug "${slug}"`
    );
    if (assistant) {
      return assistant;
    }
  } catch {
    // Slug lookup failed, try name-based search
  }

  // Fall back to listing and filtering by name
  const match = await findResourceByName((params) => client.assistants.list(params), slug, 'assistant');

  // Fetch full assistant details
  return withTimeout(
    client.assistants.get(match.id),
    TIMEOUTS_MS.ASSISTANT_FETCH,
    `Timeout fetching assistant "${match.id}"`
  );
}

/**
 * Find a datasource by name (no slug support in SDK).
 */
async function findDatasource(client: CodeMieClient, name: string): Promise<DataSource> {
  const match = await findResourceByName((params) => client.datasources.list(params), name, 'datasource');

  return withTimeout(
    client.datasources.get(match.id),
    TIMEOUTS_MS.DATASOURCE_FETCH,
    `Timeout fetching datasource "${match.id}"`
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Find a workflow by name (or directly by ID if a UUID is supplied).
 * Falls back to ID lookup when the workflow isn't visible via list()
 * (e.g. owned by a different project but shared).
 */
async function findWorkflow(client: CodeMieClient, name: string): Promise<Workflow> {
  // If caller supplied a raw UUID, skip the list search entirely.
  if (UUID_RE.test(name)) {
    return withTimeout(client.workflows.get(name), TIMEOUTS_MS.WORKFLOW_FETCH, `Timeout fetching workflow "${name}"`);
  }

  // Name-based search with pagination.
  let match: { id: string; name: string } | null = null;
  try {
    match = await findResourceByName((params) => client.workflows.list(params), name, 'workflow');
  } catch {
    // Not found via list — swallow and fall through to ID-as-name attempt below.
  }

  if (match) {
    return withTimeout(
      client.workflows.get(match.id),
      TIMEOUTS_MS.WORKFLOW_FETCH,
      `Timeout fetching workflow "${match.id}"`
    );
  }

  // List didn't find it (possibly cross-project). Re-throw with a helpful message.
  throw new Error(
    `workflow "${name}" not found on platform via name search. ` +
      `If you know its ID, pass the UUID directly instead of the name.`
  );
}

/**
 * Find a skill by name (no slug support in SDK).
 */
async function findSkill(client: CodeMieClient, name: string): Promise<SkillDetail> {
  const match = await findResourceByName((params) => client.skills.list(params), name, 'skill');

  return withTimeout(client.skills.get(match.id), TIMEOUTS_MS.SKILL_FETCH, `Timeout fetching skill "${match.id}"`);
}

/**
 * Fetch every companion file of a skill — metadata plus body — and record the metadata on the
 * skill response. `listCompanionFiles` is the authoritative list: `skills.get()` is not relied on
 * to populate `companion_files`, so the SKILL.md-plus-companions layout is chosen from what the
 * platform actually holds rather than from whatever the detail response happened to carry.
 */
async function fetchSkillCompanionFiles(client: CodeMieClient, skill: SkillDetail): Promise<SkillCompanionFile[]> {
  const metadata = await withTimeout(
    client.skills.listCompanionFiles(skill.id),
    TIMEOUTS_MS.SKILL_FETCH,
    `Timeout listing companion files for skill "${skill.id}"`
  );
  skill.companion_files = metadata;

  // Bounded parallelism rather than N+1 sequential round trips: the repo's shared limiter caps
  // in-flight requests, and Promise.all keeps the result in metadata order whatever order the
  // responses arrive in. The per-call timeout wrapper is unchanged.
  const limit = createConcurrentLimiter();

  return Promise.all(
    metadata.map((entry) =>
      limit(() =>
        withTimeout(
          client.skills.getCompanionFile(skill.id, entry.path),
          TIMEOUTS_MS.SKILL_FETCH,
          `Timeout fetching companion file "${entry.path}" of skill "${skill.id}"`
        )
      )
    )
  );
}

/**
 * Write companion file bodies beneath a skill's directory, decoding base64 so a binary file
 * survives the round trip byte-for-byte.
 */
function writeCompanionFiles(skillDir: string, companionFiles: SkillCompanionFile[]): void {
  for (const file of companionFiles) {
    // A platform-provided path is never trusted to stay inside the skill directory; a `..`
    // escape aborts the import instead of writing somewhere the user never asked for.
    const absPath = resolvePathWithinDirectory(skillDir, file.path);
    ensureDirectoryExists(absPath);
    if (file.encoding === 'base64') {
      fs.writeFileSync(absPath, Buffer.from(file.content, 'base64'));
    } else {
      fs.writeFileSync(absPath, file.content, 'utf8');
    }
    logger.info(`   📎 Saved companion file: ${file.path}`);
  }
}

/**
 * Generic paginated name search. Lists all resources across pages and matches by name (case-insensitive).
 * Throws if zero or multiple matches found.
 */
async function findResourceByName<T extends { id: string; name: string }>(
  fetchPage: (params: { per_page: number; page: number }) => Promise<T[]>,
  name: string,
  resourceType: string
): Promise<T> {
  const allResources: T[] = [];
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const resources = await fetchPage({
      per_page: PAGINATION.DEFAULT_PAGE_SIZE,
      page,
    });

    allResources.push(...resources);

    if (resources.length < PAGINATION.DEFAULT_PAGE_SIZE) {
      hasMore = false;
    } else {
      page++;
    }
  }

  const lowerName = name.toLowerCase();
  const matches = allResources.filter((r) => r.name.toLowerCase() === lowerName);

  if (matches.length === 0) {
    throw new Error(
      `${resourceType} "${name}" not found on platform. Found ${allResources.length} ${resourceType}(s) total.`
    );
  }

  if (matches.length > 1) {
    const names = matches.map((m) => `  - ${m.name} (${m.id})`).join('\n');
    throw new Error(`Multiple ${resourceType}s matching "${name}" found:\n${names}\nPlease use a more specific name.`);
  }

  return matches[0];
}

/**
 * Check if a resource already exists in the config by name.
 */
function checkResourceExists(config: CodemieConfig, resourceType: ImportResourceType, name: string): boolean {
  const pluralType = pluralTypeOf(resourceType);

  const resources = config.resources[pluralType as keyof CodemieConfig['resources']] || [];
  if (resources.some((r: { name: string }) => namesEqual(r.name, name))) {
    return true;
  }

  if (resourceType === 'skill') {
    const importedSkills = config.imported?.skills || [];
    return importedSkills.some((skill) => namesEqual(skill.name, name));
  }

  return false;
}

/**
 * Scan state.json for an entry of the given resource type whose platform id matches.
 * Returns the name it is managed under, or undefined if the id isn't managed yet.
 *
 * This is a plain `Object.keys` scan by design — state.json keeps no id -> name index,
 * since the state map is already keyed by name. If two entries were ever left sharing one
 * platform id (e.g. after an earlier duplicate import) the scan has no basis for choosing
 * between them, so it fails closed with an error naming the id and the colliding names
 * rather than silently renaming or deleting the wrong entry.
 */
function findManagedNameById(
  stateManager: StateManager,
  resourceType: ImportResourceType,
  id: string
): string | undefined {
  const state = stateManager.loadState();
  const pluralType = pluralTypeOf(resourceType);
  const resources = state.resources[pluralType as keyof StateFile['resources']] || {};
  const matches = Object.keys(resources).filter((name) => resources[name]?.id === id);

  if (matches.length > 1) {
    throw new Error(
      `state.json is ambiguous: ${matches.length} ${pluralType} entries share platform id ${id} ` +
        `(${matches.map((name) => `"${name}"`).join(', ')}). ` +
        `Remove the duplicate entries so this ${resourceType} can be matched unambiguously.`
    );
  }

  return matches[0];
}

/**
 * The single wording for a name clash in the configuration, shared by the pre-flight check on
 * the slug the caller typed and the post-resolution check on the platform-resolved name, so both
 * paths carry the `--update` hint Part 2 requires.
 */
function nameClashError(resourceType: ImportResourceType, name: string): Error {
  return new Error(
    `A ${resourceType} named "${name}" already exists in the configuration. ` +
      `Re-run with --update to replace it with the platform version, or remove it first.`
  );
}

/**
 * Ensure the platform-resolved name of a resource isn't already present in the config,
 * and that its platform id isn't already managed under a different name.
 * The pre-flight check in `importResource` covers the raw slug the caller typed; this
 * covers the case where the slug (e.g. a UUID) resolves to a different name.
 *
 * With `update: true` neither conflict is fatal — the caller is explicitly asking to
 * refresh the managed resource in place, so both checks are skipped.
 *
 * Returns the name the platform id is currently managed under (per state.json), or
 * `undefined` when the id isn't managed yet. Callers use this to locate the resource's
 * existing definition (it may have been renamed on the platform) and to fix up state.json
 * on rename under `--update`.
 */
function assertResolvedNameIsFree(
  config: CodemieConfig,
  stateManager: StateManager,
  resourceType: ImportResourceType,
  slug: string,
  resolvedName: string,
  id: string,
  update: boolean
): string | undefined {
  if (!update && !namesEqual(slug, resolvedName) && checkResourceExists(config, resourceType, resolvedName)) {
    throw nameClashError(resourceType, resolvedName);
  }

  const managedName = findManagedNameById(stateManager, resourceType, id);
  if (!update && managedName !== undefined && !namesEqual(managedName, resolvedName)) {
    throw new Error(
      `This ${resourceType} (id ${id}) is already managed by this project under the name "${managedName}", ` +
        `but is now named "${resolvedName}" on the platform.`
    );
  }

  return managedName;
}

/**
 * Write the resource YAML file and any companion files (prompts, workflow defs, skill content).
 *
 * When the platform response carries no content for a companion file, no file is written and the
 * companion key (`prompt` / `file` / `definition`) is dropped from the resource instead of keeping
 * the converter's default path, which would point the config at a file that doesn't exist.
 *
 * Returns the relative path to the resource YAML file.
 */
function writeResourceFiles(
  rootDir: string,
  resourceType: ImportResourceType,
  resource: AssistantResource | DatasourceResource | WorkflowResource | SkillResource,
  apiResponse: Assistant | DataSource | Workflow | SkillDetail,
  companionFiles: SkillCompanionFile[] = []
): string {
  const safeName = sanitizeFileName(resource.name);
  const target = resource as unknown as Record<string, unknown>;

  // Workflows: write config directly into configs/workflows/ (single file, same as hand-authored).
  // The definition YAML goes to workflows/<name>.yaml, config to configs/workflows/<name>.yaml.
  if (resourceType === 'workflow') {
    const workflow = apiResponse as Workflow;
    const workflowResource = resource as WorkflowResource;

    if (workflow.yaml_config) {
      const defFileName = `${safeName}.yaml`;
      const defPath = path.join(rootDir, 'workflows', defFileName);
      ensureDirectoryExists(defPath);
      fs.writeFileSync(defPath, workflow.yaml_config, 'utf8');
      logger.info(`   📋 Saved workflow definition: workflows/${defFileName}`);
      workflowResource.definition = `workflows/${defFileName}`;
    } else {
      // No definition was written — don't leave the config pointing at a file that doesn't exist.
      delete target.definition;
    }

    const configPath = path.join(rootDir, 'configs', 'workflows', `${safeName}.yaml`);
    const relativeConfigPath = `configs/workflows/${safeName}.yaml`;
    ensureDirectoryExists(configPath);
    const yamlContent = yaml.stringify(workflowResource, { lineWidth: 120 });
    fs.writeFileSync(configPath, yamlContent, 'utf8');
    logger.info(`   📄 Saved workflow config: ${relativeConfigPath}`);
    return relativeConfigPath;
  }

  const pluralType = pluralTypeOf(resourceType);

  const resourceDir = path.join(rootDir, 'configs', 'imported-resources', pluralType);
  const resourceFilePath = path.join(resourceDir, `${safeName}.yaml`);
  const relativeResourcePath = `configs/imported-resources/${pluralType}/${safeName}.yaml`;

  // Write companion files based on resource type
  if (resourceType === 'assistant') {
    const assistant = apiResponse as Assistant;
    const assistantResource = resource as AssistantResource;

    if (assistant.system_prompt) {
      const promptFileName = assistant.slug || safeName;
      const promptPath = path.join(rootDir, 'system_prompts', `${promptFileName}.prompt.md`);
      ensureDirectoryExists(promptPath);
      fs.writeFileSync(promptPath, assistant.system_prompt, 'utf8');
      logger.info(`   📝 Saved prompt: system_prompts/${promptFileName}.prompt.md`);

      // Update prompt path in resource to match
      assistantResource.prompt = `system_prompts/${promptFileName}.prompt.md`;
    } else {
      // No prompt file was written — don't leave the config pointing at a file that doesn't exist.
      delete target.prompt;
    }
  } else if (resourceType === 'skill') {
    const skill = apiResponse as SkillDetail;
    const skillResource = resource as SkillResource;

    if (skill.content) {
      const hasCompanionFiles = companionFiles.length > 0;
      // Same helpers the generated resource YAML and the backup writer derive their paths from.
      const relativeSkillPath = hasCompanionFiles
        ? skillMarkdownRelativePath(resource.name)
        : skillFlatFileRelativePath(resource.name);
      const skillPath = path.join(rootDir, relativeSkillPath);
      ensureDirectoryExists(skillPath);
      fs.writeFileSync(skillPath, skill.content, 'utf8');
      logger.info(`   🧠 Saved skill content: ${relativeSkillPath}`);

      if (hasCompanionFiles) {
        writeCompanionFiles(path.dirname(skillPath), companionFiles);
      }

      skillResource.file = relativeSkillPath;
    } else {
      // No content file was written — don't leave the config pointing at a file that doesn't exist.
      delete target.file;
    }
  }

  // Write the resource YAML file
  ensureDirectoryExists(resourceFilePath);
  const yamlContent = yaml.stringify(resource, { lineWidth: 120 });
  fs.writeFileSync(resourceFilePath, yamlContent, 'utf8');
  logger.info(`   📄 Saved resource config: ${relativeResourcePath}`);

  return relativeResourcePath;
}

/** A companion file (prompt / skill content / workflow definition) queued for writing. */
interface PendingCompanionWrite {
  absPath: string;
  content: string;
  log: string;
}

/**
 * Decide what happens to one companion key (`prompt`, `file`, `definition`) on the `--update`
 * path, and queue the companion file write when there is content to write.
 *
 * When the platform response carries no content for the companion, the configured path is kept
 * exactly as it is (the on-disk file stays untouched) and — if the existing resource declares no
 * such key at all — the key is dropped rather than rewritten to the converter's default, which
 * would point the config at a file that was never written.
 */
function planCompanionWrite(
  rootDir: string,
  target: Record<string, unknown>,
  key: 'prompt' | 'file' | 'definition',
  configuredValue: unknown,
  content: string | null | undefined,
  defaultPath: string,
  label: string
): PendingCompanionWrite | undefined {
  const configuredPath = typeof configuredValue === 'string' ? configuredValue : undefined;

  if (!content) {
    if (configuredPath === undefined) {
      delete target[key];
    } else {
      target[key] = configuredPath;
    }
    return undefined;
  }

  const relPath = configuredPath ?? defaultPath;
  target[key] = relPath;
  return { absPath: path.join(rootDir, relPath), content, log: `   ${label}: ${relPath}` };
}

/** Indent (in spaces) of a sequence item's map keys that the in-list splice can reproduce. */
const IN_LIST_ITEM_INDENT = 2;

/**
 * Detect the item shapes the in-list splice cannot reproduce: a merge key (`<<: *base`), an
 * alias value, or an anchor anywhere directly on the item — re-serialising any of them from the
 * plain resource object would silently drop it.
 */
function itemCarriesAnchorAliasOrMergeKey(node: yaml.YAMLMap): boolean {
  if (node.anchor !== undefined) {
    return true;
  }

  return node.items.some((pair) => {
    const key: unknown = pair.key;
    const keyValue = yaml.isScalar(key) ? key.value : key;
    if (keyValue === '<<') {
      return true;
    }

    const value: unknown = pair.value;
    if (yaml.isAlias(value)) {
      return true;
    }
    return yaml.isNode(value) && value.anchor !== undefined;
  });
}

/**
 * Build the new contents of a list file with only the matched resource's item replaced, so
 * sibling items keep their exact formatting.
 *
 * Reproducing an arbitrary source style is an explicit non-goal, so instead of writing YAML it
 * cannot faithfully produce this refuses the shapes it does not handle — non-block sequences,
 * flow-style items, items carrying anchors/aliases/merge keys, and items whose own indent isn't
 * two spaces — naming the file and telling the user to edit it by hand. Nothing is written here:
 * the caller writes the returned string only after every check has passed.
 */
function spliceResourceIntoList(
  filePath: string,
  relativeResourcePath: string,
  resource: AssistantResource | DatasourceResource | WorkflowResource | SkillResource,
  existingName: string
): string {
  const source = fs.readFileSync(filePath, 'utf8');
  const doc = yaml.parseDocument(source);

  const refusal = (reason: string): Error =>
    new Error(
      `Cannot safely update "${existingName}" inside ${relativeResourcePath}: ${reason}. ` +
        `Update ${relativeResourcePath} manually.`
    );

  if (!yaml.isSeq(doc.contents) || doc.contents.flow) {
    throw refusal('the file is not a block-style YAML sequence');
  }

  const node = doc.contents.items.find((item) => {
    if (!yaml.isMap(item)) {
      return false;
    }
    const itemName = item.get('name');
    return typeof itemName === 'string' && namesEqual(itemName, existingName);
  }) as yaml.YAMLMap | undefined;

  if (!node?.range) {
    throw refusal('its entry could not be located as a block mapping in the sequence');
  }
  if (node.flow) {
    throw refusal('its entry uses flow style ({ ... })');
  }
  if (itemCarriesAnchorAliasOrMergeKey(node)) {
    throw refusal('its entry uses a YAML anchor, alias or merge key');
  }

  const [start, valueEnd] = node.range;
  const indent = start - (source.lastIndexOf('\n', start - 1) + 1);
  if (indent !== IN_LIST_ITEM_INDENT) {
    throw refusal(`its entry is indented by ${indent} spaces instead of ${IN_LIST_ITEM_INDENT}`);
  }

  const rendered = yaml.stringify(resource, { lineWidth: 120 }).trimEnd();
  const replacement = rendered
    .split('\n')
    .map((line, index) => (index === 0 || !line ? line : `${' '.repeat(IN_LIST_ITEM_INDENT)}${line}`))
    .join('\n');
  const tail = source.slice(valueEnd);
  const separator = tail.startsWith('\n') ? '' : '\n';

  return source.slice(0, start) + replacement + separator + tail;
}

/**
 * Rewrite the file(s) defining an already-managed resource in place, for `--update`.
 *
 * Local-only keys present on the existing resource but absent from the freshly-converted
 * one are carried forward (e.g. hand-added fields) — except `skill_ids`, which this tool
 * never writes. Companion files (assistant `prompt`, skill `file`, workflow `definition`)
 * are rewritten at the path the existing resource already points to, falling back to the
 * default path only when the existing resource has no such key at all; when the platform
 * carries no content for a companion, the configured path and its file are left untouched.
 *
 * When `existing.inList` is false, the whole file is replaced with the freshly-stringified
 * resource. When it is true, only the matching item's range inside the source YAML sequence
 * is spliced out and replaced, so sibling items in the same list file keep their exact
 * formatting; source styles that splice cannot reproduce are refused (see
 * `spliceResourceIntoList`).
 *
 * Everything that can fail — serialisation and the splice preconditions — runs before the first
 * write, so a refused update leaves the working tree exactly as it was.
 *
 * Returns the path (relative to `rootDir`) of the rewritten resource file, plus whether the
 * platform's companion files actually landed on disk — only then may state record their hashes.
 */
function updateResourceFiles(
  rootDir: string,
  resourceType: ImportResourceType,
  resource: AssistantResource | DatasourceResource | WorkflowResource | SkillResource,
  apiResponse: Assistant | DataSource | Workflow | SkillDetail,
  existing: ResourceDefinition,
  companionFiles: SkillCompanionFile[] = []
): { relativeResourcePath: string; companionFilesWritten: boolean } {
  const filePath = existing.file;
  if (!filePath) {
    throw new Error('updateResourceFiles requires an existing resource backed by a file');
  }

  const existingResource = existing.resource;
  const target = resource as unknown as Record<string, unknown>;
  const safeName = sanitizeFileName(resource.name);

  // Carry over local-only fields the fresh platform response no longer declares.
  for (const [key, value] of Object.entries(existingResource)) {
    if (key === 'skill_ids' || key in target) {
      continue;
    }
    target[key] = value;
  }

  let companion: PendingCompanionWrite | undefined;
  if (resourceType === 'assistant') {
    const assistant = apiResponse as Assistant;
    companion = planCompanionWrite(
      rootDir,
      target,
      'prompt',
      existingResource.prompt,
      assistant.system_prompt,
      `system_prompts/${assistant.slug || safeName}.prompt.md`,
      '📝 Updated prompt'
    );
  } else if (resourceType === 'skill') {
    const skill = apiResponse as SkillDetail;
    const hasCompanionFiles = companionFiles.length > 0;
    // Same helpers `writeResourceFiles` and the backup writer derive their paths from, so the
    // default layout can never drift from the one the rest of the tool writes and reads.
    const defaultSkillPath = hasCompanionFiles
      ? skillMarkdownRelativePath(resource.name)
      : skillFlatFileRelativePath(resource.name);
    companion = planCompanionWrite(
      rootDir,
      target,
      'file',
      existingResource.file,
      skill.content,
      defaultSkillPath,
      '🧠 Updated skill content'
    );
  } else if (resourceType === 'workflow') {
    const workflow = apiResponse as Workflow;
    companion = planCompanionWrite(
      rootDir,
      target,
      'definition',
      existingResource.definition,
      workflow.yaml_config,
      `workflows/${safeName}.yaml`,
      '📋 Updated workflow definition'
    );
  }

  const relativeResourcePath = path.relative(rootDir, filePath);

  // Serialise (and validate the splice) before touching the filesystem.
  const newResourceFileContent = existing.inList
    ? spliceResourceIntoList(filePath, relativeResourcePath, resource, String(existingResource.name))
    : yaml.stringify(resource, { lineWidth: 120 });

  // Companions live beside the skill's own markdown, so they only make sense for the
  // SKILL.md layout — a flat <name>.skill.md has no directory of its own to fill. The same
  // predicate deploy uses decides it, from the path the config actually points at.
  const companionFilesWritten =
    resourceType === 'skill' &&
    companionFiles.length > 0 &&
    companion !== undefined &&
    hasCompanionFileLayout(resource as SkillResource);

  if (companion) {
    ensureDirectoryExists(companion.absPath);
    fs.writeFileSync(companion.absPath, companion.content, 'utf8');
    logger.info(companion.log);

    if (companionFilesWritten) {
      writeCompanionFiles(path.dirname(companion.absPath), companionFiles);
    }
  }

  // Nothing was written, so nothing is managed here: the caller must keep the hashes out of
  // state, or the next deploy would collect no companions locally, see the state hashes, and
  // send `companion_files: []` — deleting the platform's files.
  if (resourceType === 'skill' && companionFiles.length > 0 && !companionFilesWritten) {
    logger.warn(
      `   ⚠️  Skill "${resource.name}" has ${companionFiles.length} companion file(s) on the platform, but none ` +
        `were written locally (configured file: "${(resource as SkillResource).file ?? '(none)'}"): they stay on ` +
        `the platform and are not managed locally. Point the entry at a skills/<name>/SKILL.md layout to manage them.`
    );
  }

  fs.writeFileSync(filePath, newResourceFileContent, 'utf8');
  logger.info(`   📄 Updated resource config: ${relativeResourcePath}`);
  return { relativeResourcePath, companionFilesWritten };
}

/**
 * Drop a state.json entry for a resource, used when `--update` finds the platform resource
 * was renamed: the old name's entry is removed before `updateState` writes the new one.
 */
function deleteStateEntry(stateManager: StateManager, resourceType: ImportResourceType, name: string): void {
  switch (resourceType) {
    case 'assistant': {
      stateManager.deleteAssistantState(name);
      break;
    }
    case 'datasource': {
      stateManager.deleteDatasourceState(name);
      break;
    }
    case 'workflow': {
      stateManager.deleteWorkflowState(name);
      break;
    }
    case 'skill': {
      stateManager.deleteSkillState(name);
      break;
    }
  }
}

/**
 * Add a $import directive for the new resource to codemie.yaml.
 * Reads the raw YAML, appends the import directive, and writes back.
 */
function addImportToCodemieYaml(
  rootDir: string,
  codemieConfigPath: string,
  resourceType: ImportResourceType,
  relativeResourcePath: string
): void {
  const configPath = path.join(rootDir, codemieConfigPath);

  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }

  const content = fs.readFileSync(configPath, 'utf8');
  const doc = yaml.parseDocument(content);

  const pluralType = pluralTypeOf(resourceType);

  // Navigate to resources.<pluralType>
  let resourcesNode = doc.get('resources') as yaml.YAMLMap | undefined;
  if (!resourcesNode) {
    resourcesNode = doc.createNode({}) as yaml.YAMLMap;
    doc.set('resources', resourcesNode);
  }

  let typeArray = doc.getIn(['resources', pluralType]) as yaml.YAMLSeq | undefined;
  if (!typeArray) {
    typeArray = doc.createNode([]) as yaml.YAMLSeq;
    doc.setIn(['resources', pluralType], typeArray);
  }

  // Check if the $import already exists
  const importDirective = { $import: relativeResourcePath };
  const existingImports = typeArray.items.filter((item): item is yaml.YAMLMap => {
    if (yaml.isMap(item)) {
      const importValue = item.get('$import');
      return importValue === relativeResourcePath;
    }
    return false;
  });

  if (existingImports.length > 0) {
    logger.info(`   ↷ Import directive already exists in ${codemieConfigPath}`);
    return;
  }

  // Append the new import directive
  const newNode = doc.createNode(importDirective);
  typeArray.add(newNode);

  fs.writeFileSync(configPath, doc.toString(), 'utf8');
  logger.info(`   ✅ Added $import to ${codemieConfigPath} → resources.${pluralType}`);
}

/**
 * Add a platform-managed skill reference to imported.skills in codemie.yaml.
 */
function addImportedSkillToCodemieYaml(rootDir: string, codemieConfigPath: string, skill: ImportedResource): void {
  const configPath = path.join(rootDir, codemieConfigPath);

  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }

  const content = fs.readFileSync(configPath, 'utf8');
  const doc = yaml.parseDocument(content);

  let importedNode = doc.get('imported') as yaml.YAMLMap | undefined;
  if (!importedNode) {
    importedNode = doc.createNode({ assistants: [], datasources: [], skills: [], integrations: [] }) as yaml.YAMLMap;
    doc.set('imported', importedNode);
  }

  let skillsArray = doc.getIn(['imported', 'skills']) as yaml.YAMLSeq | undefined;
  if (!skillsArray) {
    skillsArray = doc.createNode([]) as yaml.YAMLSeq;
    doc.setIn(['imported', 'skills'], skillsArray);
  }

  const existingSkill = skillsArray.items.find((item): item is yaml.YAMLMap => {
    if (!yaml.isMap(item)) {
      return false;
    }
    const existingName = item.get('name');
    return typeof existingName === 'string' && namesEqual(existingName, skill.name);
  });

  if (existingSkill) {
    const existingId = existingSkill.get('id');
    if (existingId && existingId !== skill.id) {
      throw new Error(
        `Skill "${skill.name}" already exists in imported.skills with a different ID (${existingId}). ` +
          `Remove the existing entry or use the intended skill ID.`
      );
    }
    logger.info(`   ↷ Skill "${skill.name}" already exists in imported.skills`);
    return;
  }

  skillsArray.add(doc.createNode({ name: skill.name, id: skill.id }));
  fs.writeFileSync(configPath, doc.toString(), 'utf8');
  logger.info(`   ✅ Added skill to ${codemieConfigPath} → imported.skills`);
}

/**
 * Refresh an existing imported.skills entry in place with a fresh name/id from the platform.
 *
 * Locates the entry by id first (the rename case — the local name is stale) and falls back to
 * a name match via `namesEqual` (the same-name-new-id case). Rewrites both fields through
 * `yaml.parseDocument` node mutation so surrounding comments and formatting survive.
 *
 * Returns `true` when an entry was found and rewritten, `false` when nothing matched — the
 * caller falls back to `addImportedSkillToCodemieYaml` in that case. Writes nothing to disk
 * when it returns `false`.
 */
function updateImportedSkillInCodemieYaml(
  rootDir: string,
  codemieConfigPath: string,
  skill: ImportedResource
): boolean {
  const configPath = path.join(rootDir, codemieConfigPath);

  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }

  const content = fs.readFileSync(configPath, 'utf8');
  const doc = yaml.parseDocument(content);

  const skillsArray = doc.getIn(['imported', 'skills']) as yaml.YAMLSeq | undefined;
  if (!skillsArray) {
    return false;
  }

  const items = skillsArray.items.filter((item): item is yaml.YAMLMap => yaml.isMap(item));

  const entryById = items.find((item) => {
    const existingId = item.get('id');
    return typeof existingId === 'string' && existingId === skill.id;
  });

  const entry =
    entryById ??
    items.find((item) => {
      const existingName = item.get('name');
      return typeof existingName === 'string' && namesEqual(existingName, skill.name);
    });

  if (!entry) {
    return false;
  }

  entry.set('name', skill.name);
  entry.set('id', skill.id);

  fs.writeFileSync(configPath, doc.toString(), 'utf8');
  return true;
}

/**
 * Record an external (platform-owned) skill in `imported.skills`.
 *
 * With `update: true` an existing entry is refreshed in place first (matched by id, then by
 * name), so a skill renamed on the platform updates its one entry instead of gaining a second
 * one — this holds both for `import skill` and for a skill reached indirectly through an
 * assistant's `skill_ids`. When nothing matches, the required "importing as new" line is logged
 * and the skill is appended. Without `update` the behaviour is unchanged: append, and let
 * `addImportedSkillToCodemieYaml` refuse a same-name/different-id collision.
 */
function upsertImportedSkill(
  rootDir: string,
  codemieConfigPath: string,
  skill: ImportedResource,
  update: boolean
): void {
  if (update) {
    if (updateImportedSkillInCodemieYaml(rootDir, codemieConfigPath, skill)) {
      logger.info(`   ♻️  Refreshed imported.skills entry for external skill "${skill.name}"`);
      return;
    }
    logger.info(`   No existing skill found in the configuration — importing as new`);
  }

  addImportedSkillToCodemieYaml(rootDir, codemieConfigPath, skill);
}

function ensureExternalSkillDoesNotConflictWithManagedSkill(config: CodemieConfig, skillName: string): void {
  const managedSkill = config.resources.skills?.find((skill) => namesEqual(skill.name, skillName));
  if (!managedSkill) {
    return;
  }

  throw new Error(
    `External skill "${skillName}" is already defined in resources.skills. ` +
      `Keep project-owned skills in resources.skills or external skills in imported.skills, not both.`
  );
}

/**
 * Import a project-owned skill referenced by an assistant, exactly the way the `skill` branch of
 * `importResource` imports a new one: companion files are fetched, `skills/<name>.skill.md` plus the
 * resource YAML are written, the YAML is wired into codemie.yaml and state.json records the skill.
 * Only reached under `--with-skills`, and only for a skill the configuration does not manage yet.
 */
async function importReferencedProjectSkill(
  client: CodeMieClient,
  rootDir: string,
  codemieConfigPath: string,
  stateManager: StateManager,
  skill: SkillDetail
): Promise<void> {
  const companionFiles = await fetchSkillCompanionFiles(client, skill);
  const skillResource = skillResponseToResource(skill);
  const relativeSkillPath = writeResourceFiles(rootDir, 'skill', skillResource, skill, companionFiles);
  addImportToCodemieYaml(rootDir, codemieConfigPath, 'skill', relativeSkillPath);
  updateState(stateManager, 'skill', skillResource, skill, companionFiles);
  logger.info(`     ✓ Imported project-owned skill "${skill.name}" into resources.skills`);
}

/**
 * Update state.json with the imported resource so preview recognizes it.
 */
function updateState(
  stateManager: StateManager,
  resourceType: ImportResourceType,
  resource: AssistantResource | DatasourceResource | WorkflowResource | SkillResource,
  apiResponse: Assistant | DataSource | Workflow | SkillDetail,
  companionFiles: SkillCompanionFile[] = []
): void {
  switch (resourceType) {
    case 'assistant': {
      const assistant = apiResponse as Assistant;
      const assistantResource = resource as AssistantResource;
      stateManager.updateAssistantState(resource.name, assistant.id, assistant.system_prompt || '', assistantResource);
      break;
    }
    case 'datasource': {
      const datasource = apiResponse as DataSource;
      const datasourceResource = resource as DatasourceResource;
      stateManager.updateDatasourceState(resource.name, datasource.id, datasourceResource);
      break;
    }
    case 'workflow': {
      const workflow = apiResponse as Workflow;
      const workflowResource = resource as WorkflowResource;
      stateManager.updateWorkflowState(
        resource.name,
        workflow.id,
        calculateChecksum(workflow.yaml_config || ''),
        calculateWorkflowConfigChecksum(workflowResource)
      );
      break;
    }
    case 'skill': {
      const skill = apiResponse as SkillDetail;
      const skillResource = resource as SkillResource;
      // Omitted when there are none, so a companion-less skill's entry keeps neither key —
      // the absence is what deploy reads as "no companion files".
      stateManager.updateSkillState(
        resource.name,
        skill.id,
        skill.content || '',
        skillResource,
        companionFiles.length > 0 ? companionFiles : undefined
      );
      break;
    }
  }
}

/**
 * Build integration ID → alias map from existing config imported integrations.
 */
function buildIntegrationAliasMap(config: CodemieConfig): Map<string, string> {
  const map = new Map<string, string>();
  for (const integration of config.imported?.integrations || []) {
    if (integration.id && integration.alias) {
      map.set(integration.id, integration.alias);
    }
  }
  return map;
}

/**
 * Import a single resource from the CodeMie platform into the local IaC configuration.
 */
export async function importResource(options: ImportOptions): Promise<void> {
  const { appConfig, resourceType, slug, update = false, withSkills = false } = options;

  if (!VALID_RESOURCE_TYPES.includes(resourceType)) {
    throw new Error(`Invalid resource type: "${resourceType}". Must be one of: ${VALID_RESOURCE_TYPES.join(', ')}`);
  }

  if (withSkills && resourceType !== 'assistant') {
    logger.warn(`   ⚠️  --with-skills only applies to assistants — ignoring it for ${resourceType}.`);
  }

  const configLoader = new CodemieConfigLoader(appConfig);
  const config = configLoader.loadConfig();
  const rootDir = appConfig.rootDir;
  const stateManager = new StateManager(appConfig);

  // Check if resource already exists in config. Skipped under --update: the caller is
  // explicitly asking to refresh the already-managed resource in place.
  if (!update && checkResourceExists(config, resourceType, slug)) {
    throw nameClashError(resourceType, slug);
  }

  logger.info(`\n🔍 Importing ${resourceType}: "${slug}"\n`);
  logger.info('   Connecting to CodeMie platform...');
  const client = await createClient(config);

  const integrationAliasMap = buildIntegrationAliasMap(config);

  let resource: AssistantResource | DatasourceResource | WorkflowResource | SkillResource;
  let apiResponse: Assistant | DataSource | Workflow | SkillDetail;
  // Name the platform id is currently managed under (per state.json), captured from
  // assertResolvedNameIsFree so the --update path below can locate the existing definition
  // and fix up state.json when the platform resource was renamed.
  let managedName: string | undefined;
  // Companion files of a project-owned skill, fetched once and reused by the write, the
  // in-place update and the state entry.
  let skillCompanionFiles: SkillCompanionFile[] = [];

  switch (resourceType) {
    case 'assistant': {
      logger.info(`   Searching for assistant "${slug}"...`);
      const assistant = await findAssistant(client, slug);
      logger.info(`   ✓ Found: ${assistant.name} (${assistant.id})`);
      managedName = assertResolvedNameIsFree(
        config,
        stateManager,
        resourceType,
        slug,
        assistant.name,
        assistant.id,
        update
      );
      apiResponse = assistant;
      resource = assistantResponseToResource(assistant);

      // Transform toolkit/MCP server integration references if we have alias mapping
      if (integrationAliasMap.size > 0) {
        const { transformToolkits, transformMcpServer } = await import('./lib/backupTransformers');
        const transformedToolkits = transformToolkits(assistant.toolkits, integrationAliasMap);
        const transformedMcpServers = assistant.mcp_servers?.map((mcp) => transformMcpServer(mcp, integrationAliasMap));
        if (transformedToolkits) {
          (resource as AssistantResource).toolkits = transformedToolkits;
        }
        if (transformedMcpServers) {
          (resource as AssistantResource).mcp_servers = transformedMcpServers;
        }
      }

      // Resolve skill_ids to skill names
      const assistantData = assistant as AssistantWithSkills;
      if (assistantData.skill_ids && assistantData.skill_ids.length > 0) {
        logger.info(`   Resolving ${assistantData.skill_ids.length} skill ID(s)...`);
        const skillNames: string[] = [];
        // Lower-cased names of the project-owned skills this run imported, so the freshly written
        // entries are visible to the already-managed check (the loaded config predates them).
        const importedProjectSkills = new Set<string>();
        for (const skillId of assistantData.skill_ids) {
          let skill: SkillDetail;
          try {
            skill = await withTimeout(
              client.skills.get(skillId),
              TIMEOUTS_MS.ASSISTANT_FETCH,
              `Timeout fetching skill "${skillId}"`
            );
          } catch {
            logger.warn(`     ⚠️  Could not resolve skill ID "${skillId}" — skipping`);
            continue;
          }

          skillNames.push(skill.name);
          logger.info(`     ✓ Resolved skill ${skillId.slice(0, 8)}... → "${skill.name}"`);

          if (!isProjectOwnedSkill(skill, config.project.name)) {
            ensureExternalSkillDoesNotConflictWithManagedSkill(config, skill.name);
            upsertImportedSkill(rootDir, appConfig.codemieConfig, { name: skill.name, id: skill.id }, update);
            continue;
          }

          // A project-owned skill the configuration already names — in resources.skills, or tracked
          // as external in imported.skills — is left exactly as it is, under `--update` too: the
          // caller asked to refresh the assistant, not to overwrite the skills it happens to use.
          // `importedProjectSkills` covers an assistant that lists the same skill id twice.
          if (
            withSkills &&
            !checkResourceExists(config, 'skill', skill.name) &&
            !importedProjectSkills.has(skill.name.toLowerCase())
          ) {
            // The id can still be managed under a pre-rename name, which the config lookup above
            // cannot see. Importing it as new would leave two state entries sharing one id, so the
            // skill is left alone and the targeted command that fixes it is named instead.
            const managedSkillName = findManagedNameById(stateManager, 'skill', skill.id);
            if (managedSkillName !== undefined) {
              logger.warn(
                `     ⚠️  Skill "${skill.name}" is already managed under the name "${managedSkillName}" — not imported. ` +
                  `Run \`codemie import skill ${skill.id} --update\` to refresh it.`
              );
              continue;
            }

            await importReferencedProjectSkill(client, rootDir, appConfig.codemieConfig, stateManager, skill);
            importedProjectSkills.add(skill.name.toLowerCase());
          }
        }
        if (skillNames.length > 0) {
          (resource as AssistantResource).skills = skillNames;
        }
      }
      break;
    }
    case 'datasource': {
      logger.info(`   Searching for datasource "${slug}"...`);
      const datasource = await findDatasource(client, slug);
      logger.info(`   ✓ Found: ${datasource.name} (${datasource.id})`);
      managedName = assertResolvedNameIsFree(
        config,
        stateManager,
        resourceType,
        slug,
        datasource.name,
        datasource.id,
        update
      );
      apiResponse = datasource;

      const settingId = datasource.setting_id || '';
      const integrationAlias = integrationAliasMap.get(settingId);
      resource = datasourceResponseToResource(datasource, integrationAlias);
      break;
    }
    case 'workflow': {
      logger.info(`   Searching for workflow "${slug}"...`);
      const workflow = await findWorkflow(client, slug);
      logger.info(`   ✓ Found: ${workflow.name} (${workflow.id})`);
      // When slug is a UUID the pre-check used the ID — verify the resolved name isn't already present.
      managedName = assertResolvedNameIsFree(
        config,
        stateManager,
        resourceType,
        slug,
        workflow.name,
        workflow.id,
        update
      );
      apiResponse = workflow;
      resource = workflowResponseToResource(workflow);
      break;
    }
    case 'skill': {
      logger.info(`   Searching for skill "${slug}"...`);
      const skill = await findSkill(client, slug);
      logger.info(`   ✓ Found: ${skill.name} (${skill.id})`);

      managedName = assertResolvedNameIsFree(config, stateManager, resourceType, slug, skill.name, skill.id, update);

      if (isProjectOwnedSkill(skill, config.project.name)) {
        logger.info(`   Project-owned skill — importing into resources.skills`);
        apiResponse = skill;
        skillCompanionFiles = await fetchSkillCompanionFiles(client, skill);
        resource = skillResponseToResource(skill);
        break;
      }

      upsertImportedSkill(rootDir, appConfig.codemieConfig, { name: skill.name, id: skill.id }, update);
      logger.info(`\n✅ Successfully imported external skill "${skill.name}" into imported.skills\n`);
      return;
    }
  }

  if (update) {
    const pluralType = pluralTypeOf(resourceType);
    // Prefer the name the resource is currently managed under (it may have been renamed on
    // the platform, in which case the config still holds the old name); fall back to the
    // freshly-resolved name for a resource not yet tracked in state.json.
    const lookupName = managedName ?? resource.name;
    const existing = findResourceDefinition(rootDir, appConfig.codemieConfig, pluralType, lookupName);

    if (existing) {
      if (existing.file === null) {
        throw new Error(
          `Cannot update "${resource.name}": it is not defined in a file referenced by codemie.yaml. ` +
            `Update it manually.`
        );
      }

      logger.info(`   ♻️  Updating existing ${resourceType} config in place...`);
      const { companionFilesWritten } = updateResourceFiles(
        rootDir,
        resourceType,
        resource,
        apiResponse,
        existing,
        skillCompanionFiles
      );

      if (managedName !== undefined && !namesEqual(managedName, resource.name)) {
        logger.info(`   🏷️  Renamed from "${managedName}" to "${resource.name}" — updating state.json`);
        deleteStateEntry(stateManager, resourceType, managedName);
      }

      // Companion hashes only when the files really are on disk — see `updateResourceFiles`.
      updateState(
        stateManager,
        resourceType,
        resource,
        apiResponse,
        companionFilesWritten ? skillCompanionFiles : undefined
      );
      logger.info(`\n✅ Successfully imported ${resourceType} "${resource.name}"\n`);
      return;
    }

    logger.info(`   No existing ${resourceType} found in the configuration — importing as new`);
  }

  // Write resource files + companion files (prompts, workflow defs)
  const relativeResourcePath = writeResourceFiles(rootDir, resourceType, resource, apiResponse, skillCompanionFiles);

  // Add $import directive to codemie.yaml
  addImportToCodemieYaml(rootDir, appConfig.codemieConfig, resourceType, relativeResourcePath);

  // Update state.json
  updateState(stateManager, resourceType, resource, apiResponse, skillCompanionFiles);

  logger.info(`\n✅ Successfully imported ${resourceType} "${resource.name}"\n`);
}

/**
 * CLI entry point for the import command.
 */
export async function main(options: ImportOptions): Promise<void> {
  try {
    await importResource(options);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`\n❌ Import failed: ${errorMessage}\n`);
    process.exitCode = 1;
  }
}
