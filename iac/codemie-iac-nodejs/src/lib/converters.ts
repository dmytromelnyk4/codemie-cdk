/*
 * Copyright © 2025 EPAM Systems, Inc. All Rights Reserved. All information contained herein is, and remains the
 * property of EPAM Systems, Inc. and/or its suppliers and is protected by international intellectual
 * property law. Dissemination of this information or reproduction of this material is strictly forbidden,
 * unless prior written permission is obtained from EPAM Systems, Inc
 */

import type {
  MCPServerDetails,
  DataSourceCreateParams,
  DataSourceTypeType,
  CodeDataSourceTypeType,
  Assistant,
  DataSource,
  Workflow,
  AssistantCreateParams,
  SkillDetail,
} from 'codemie-sdk';
import { DataSourceType } from 'codemie-sdk';

import type {
  AssistantResource,
  DatasourceResource,
  IaCMcpServer,
  IaCTool,
  IaCToolkit,
  SkillResource,
  WorkflowResource,
} from '../types/codemieConfig';

import { DEFAULT_LLM_MODEL } from './checksumUtils';
import { skillFlatFileRelativePath } from './fileUtils';
import { logger } from './logger';
import { sanitizeMcpServer } from './mcpSanitizer';
import { isResolvedIntegration } from './typeGuards';

export type AssistantResponse = Assistant;
export type DatasourceResponse = DataSource;
export type WorkflowResponse = Workflow;
export type SkillResponse = SkillDetail;

const CHUNK_SUMMARY_ALIASES = new Set<string>(['chunk_summary', 'chunk-summary']);
const FILE_SUMMARY_ALIASES = new Set<string>(['file_summary', 'file-summary', 'file-summay']);

function isChunkSummaryType(type: string): boolean {
  return CHUNK_SUMMARY_ALIASES.has(type);
}

function isFileSummaryType(type: string): boolean {
  return FILE_SUMMARY_ALIASES.has(type);
}

function normalizeCodeIndexType(datasource: DatasourceResponse): CodeDataSourceTypeType | undefined {
  if (datasource.code?.indexType) {
    return datasource.code.indexType;
  }

  if (datasource.type === DataSourceType.CODE || datasource.type === DataSourceType.SUMMARY) {
    return datasource.type;
  }

  if (datasource.type === DataSourceType.CHUNK_SUMMARY) {
    return DataSourceType.CHUNK_SUMMARY;
  }

  if (isFileSummaryType(datasource.type)) {
    return DataSourceType.SUMMARY;
  }

  if (isChunkSummaryType(datasource.type)) {
    return DataSourceType.CHUNK_SUMMARY;
  }

  return undefined;
}

function validateMcpCommandArgs(s: Record<string, unknown>, hasTopLevelCommand: boolean): boolean {
  if (hasTopLevelCommand) {
    // Legacy flat structure: check s.arguments (string) - no validation needed, always valid
    // Note: SDK defines 'arguments' as string, not array
    return true;
  }

  // Config structure: check config.args (array)
  const config = s.config as Record<string, unknown>;
  const configArgs = config.args;
  if (!Array.isArray(configArgs)) {
    return false;
  }
  return configArgs.every((arg) => typeof arg === 'string');
}

function isValidMcpServer(server: unknown): server is IaCMcpServer {
  if (!server || typeof server !== 'object') {
    return false;
  }
  const s = server as Record<string, unknown>;

  if (typeof s.name !== 'string' || s.name.length === 0) {
    return false;
  }

  // Check for command at top level (flat structure) OR in config object (API structure)
  const hasTopLevelCommand = typeof s.command === 'string' && s.command.length > 0;
  const hasConfigCommand =
    s.config &&
    typeof s.config === 'object' &&
    typeof (s.config as Record<string, unknown>).command === 'string' &&
    ((s.config as Record<string, unknown>).command as string).length > 0;
  const hasCommand = hasTopLevelCommand || hasConfigCommand;

  // Check for URL (remote connection) - can be at top level OR in config
  const hasTopLevelUrl = typeof s.mcp_connect_url === 'string' && s.mcp_connect_url.length > 0;
  const hasConfigUrl =
    s.config &&
    typeof s.config === 'object' &&
    typeof (s.config as Record<string, unknown>).url === 'string' &&
    ((s.config as Record<string, unknown>).url as string).length > 0;
  const hasUrl = hasTopLevelUrl || hasConfigUrl;

  // MCP server can have:
  // - command (local execution) - can be null if using settings
  // - URL (remote connection)
  // - settings (integration reference) - command and arguments can both be null
  // - mcp_config_id (saved platform MCP configuration reference)
  const hasSettings = s.settings != null;
  const hasMcpConfigId = typeof s.mcp_config_id === 'string' && s.mcp_config_id.length > 0;

  // Cannot have both command and URL
  if (hasCommand && hasUrl) {
    return false;
  }

  // Valid if it has at least one of: command, url, settings, or saved config id
  if (!hasCommand && !hasUrl && !hasSettings && !hasMcpConfigId) {
    return false;
  }

  // Command-based servers require args array
  if (hasCommand && !validateMcpCommandArgs(s, hasTopLevelCommand)) {
    return false;
  }

  if (s.description != null && typeof s.description !== 'string') {
    return false;
  }
  if (s.enabled !== undefined && typeof s.enabled !== 'boolean') {
    return false;
  }

  return true;
}

function convertMcpServers(servers: MCPServerDetails[]): IaCMcpServer[] | undefined {
  if (!servers || servers.length === 0) {
    return undefined;
  }

  // Filter valid servers - SDK types are compatible with IaC types (IaC is more permissive)
  const validServers = servers.filter((server) => isValidMcpServer(server));

  if (validServers.length === 0) {
    return undefined;
  }

  // Validate first, sanitize second: isValidMcpServer keeps seeing the raw server
  return validServers.map((server) => sanitizeMcpServer(server));
}

export function assistantResponseToResource(assistant: AssistantResponse): AssistantResource {
  const safeName = assistant.name || assistant.id || 'assistant';
  const slug = assistant.slug || '';
  const promptFileName = slug || String(safeName).toLowerCase().replaceAll(/\s+/g, '-');

  const mcpServers = convertMcpServers(assistant.mcp_servers);

  const nestedAssistants = assistant.nested_assistants;
  const subAssistants = nestedAssistants?.map((nested) => nested.name).filter((name): name is string => Boolean(name));

  const categories = assistant.categories?.map((category) => category.id);

  return {
    name: assistant.name || safeName,
    description: assistant.description || '',
    prompt: `system_prompts/${promptFileName}.prompt.md`,
    model: assistant.llm_model_type || DEFAULT_LLM_MODEL,
    ...(assistant.temperature !== undefined &&
      assistant.temperature !== null && { temperature: assistant.temperature }),
    ...(assistant.top_p !== undefined && assistant.top_p !== null && { top_p: assistant.top_p }),
    ...(assistant.shared !== undefined && { shared: assistant.shared }),
    ...(assistant.is_react !== undefined && { is_react: assistant.is_react }),
    ...(assistant.is_global !== undefined && { is_global: assistant.is_global }),
    ...(assistant.icon_url && { icon_url: assistant.icon_url }),
    ...(assistant.conversation_starters && { conversation_starters: assistant.conversation_starters }),
    ...(assistant.toolkits && { toolkits: assistant.toolkits }),
    ...(assistant.context && { context: assistant.context }),
    ...(mcpServers && { mcp_servers: mcpServers }),
    ...(subAssistants && { sub_assistants: subAssistants }),
    ...(assistant.prompt_variables && { prompt_variables: assistant.prompt_variables }),
    ...(categories && { categories }),
  };
}

export function convertCodeDatasource(
  datasource: DatasourceResponse,
  base: {
    name: string;
    type: DataSourceTypeType;
    embeddings_model?: string;
    setting_id?: string;
    shared_with_project?: boolean;
  }
): DatasourceResource {
  const desc = datasource.description || '';
  const indexType = normalizeCodeIndexType(datasource);

  if (datasource.code) {
    return {
      ...base,
      type: 'code',
      description: desc,
      link: datasource.code.link,
      branch: datasource.code.branch,
      ...(indexType && { index_type: indexType }),
      summarization_model: datasource.code.summarizationModel,
      files_filter: datasource.code.filesFilter,
    };
  }

  return {
    ...base,
    type: 'code',
    description: desc,
    ...(indexType && { index_type: indexType }),
    link: undefined,
  };
}

// eslint-disable-next-line max-lines-per-function
export function datasourceResponseToResource(
  datasource: DatasourceResponse,
  integrationAlias?: string
): DatasourceResource {
  const isBedrockDatasource = datasource.type === DataSourceType.BEDROCK;
  const isChunkSummaryDatasource = isChunkSummaryType(datasource.type);
  const isFileSummaryDatasource = isFileSummaryType(datasource.type);
  const isCodeFamilyDatasource =
    datasource.type === DataSourceType.CODE ||
    datasource.type === DataSourceType.SUMMARY ||
    datasource.type === DataSourceType.CHUNK_SUMMARY ||
    isChunkSummaryDatasource ||
    isFileSummaryDatasource;

  const settingId = integrationAlias
    ? `$ref:imported.integrations.${integrationAlias}.id`
    : (datasource.setting_id ?? '');

  const allowedWithoutSettingId = new Set<string>([DataSourceType.FILE, DataSourceType.GOOGLE, DataSourceType.BEDROCK]);

  if (!settingId && !allowedWithoutSettingId.has(datasource.type)) {
    logger.warn(`⚠️  Datasource "${datasource.name}" is missing setting_id (integration reference)`);
  }

  const base = {
    name: datasource.name,
    type: datasource.type,
    embeddings_model: datasource.embeddings_model,
    setting_id: settingId || undefined,
    shared_with_project: datasource.shared_with_project,
  };

  if (isCodeFamilyDatasource) {
    return convertCodeDatasource(datasource, base);
  }

  if (datasource.type === DataSourceType.CONFLUENCE && datasource.confluence) {
    return {
      ...base,
      type: DataSourceType.CONFLUENCE,
      description: datasource.description || '',
      ...datasource.confluence,
    };
  }

  if (datasource.type === DataSourceType.JIRA && datasource.jira) {
    return {
      ...base,
      type: DataSourceType.JIRA,
      description: datasource.description || '',
      ...datasource.jira,
    };
  }

  if (datasource.type === DataSourceType.GOOGLE && datasource.google_doc_link) {
    return {
      ...base,
      type: DataSourceType.GOOGLE,
      description: datasource.description || '',
      google_doc: datasource.google_doc_link,
    };
  }

  if (datasource.type === DataSourceType.FILE) {
    return {
      ...base,
      type: DataSourceType.FILE,
      description: datasource.description || '',
    };
  }

  // Bedrock/chunk-summary/file-summary datasources are imported for assistant usage.
  // Keep minimal stable fields for bedrock imports.
  if (isBedrockDatasource) {
    return {
      ...base,
      type: datasource.type,
      description: datasource.description || '',
    } as DatasourceResource;
  }

  logger.warn(`    ⚠️  Unknown datasource type '${datasource.type}' - saving with basic fields only`);
  return {
    ...base,
    description: datasource.description || '',
  } as DatasourceResource;
}

export function workflowResponseToResource(workflow: WorkflowResponse): WorkflowResource {
  const safeName = workflow.name || workflow.id || 'workflow';
  return {
    name: workflow.name || safeName,
    description: workflow.description || '',
    definition: `workflows/${String(safeName).toLowerCase().replaceAll(/\s+/g, '-')}.yaml`,
    ...(workflow.mode && { mode: workflow.mode }),
    ...(workflow.shared !== undefined && { shared: workflow.shared }),
    ...(workflow.icon_url && { icon_url: workflow.icon_url }),
  };
}

export function skillResponseToResource(skill: SkillResponse): SkillResource {
  return {
    name: skill.name,
    description: skill.description || '',
    // Derived from the one shared helper the backup and import writers use, so the path in the
    // generated YAML is always the path that was actually written to disk.
    file: skillFlatFileRelativePath(skill.name),
    ...(skill.categories && skill.categories.length > 0 && { categories: skill.categories }),
    ...(skill.visibility && skill.visibility !== 'project' && { visibility: skill.visibility }),
  };
}

function isValidCodeParams(params: unknown): params is { link: string } {
  return (
    typeof params === 'object' &&
    params !== null &&
    'link' in params &&
    typeof (params as { link: unknown }).link === 'string' &&
    (params as { link: string }).link.length > 0
  );
}

export function datasourceResourceToCreateParams(
  datasource: DatasourceResource,
  projectName: string
): DataSourceCreateParams {
  const {
    $ref: _ref,
    force_reindex: _forceReindex,
    ...sdkFields
  } = datasource as Omit<DatasourceResource, '$ref' | 'force_reindex'> & {
    $ref?: string;
    force_reindex?: boolean;
  };

  const params = {
    ...sdkFields,
    project_name: projectName,
    shared_with_project: datasource.shared_with_project ?? true,
  };

  if (datasource.type === 'code' && !isValidCodeParams(params)) {
    throw new Error(
      `Invalid code datasource "${datasource.name}": missing required field "link". ` +
        `Please add repository URL to datasource configuration.`
    );
  } else if (datasource.type === 'knowledge_base_confluence' && (!('cql' in params) || !params.cql)) {
    throw new Error(
      `Invalid Confluence datasource "${datasource.name}": missing required field "cql". ` +
        `Please add CQL query to datasource configuration.`
    );
  } else if (datasource.type === 'knowledge_base_jira' && (!('jql' in params) || !params.jql)) {
    throw new Error(
      `Invalid Jira datasource "${datasource.name}": missing required field "jql". ` +
        `Please add JQL query to datasource configuration.`
    );
  } else if (datasource.type === 'llm_routing_google' && (!('google_doc' in params) || !params.google_doc)) {
    throw new Error(
      `Invalid Google Docs datasource "${datasource.name}": missing required field "google_doc". ` +
        `Please add Google Doc ID to datasource configuration.`
    );
  }

  return params as DataSourceCreateParams;
}

type SdkToolkit = NonNullable<AssistantCreateParams['toolkits']>[0];
type SdkTool = SdkToolkit['tools'][0];
type SdkMcpServer = NonNullable<AssistantCreateParams['mcp_servers']>[0];

/**
 * Convert IaC tool to SDK format
 * settings_config inferred from presence of settings if not explicitly set
 * Only resolved integrations are passed to SDK (not $ref)
 */
function iacToolToSdk(tool: IaCTool): SdkTool {
  return {
    ...tool,
    settings_config: tool.settings_config ?? Boolean(tool.settings),
    settings: isResolvedIntegration(tool.settings) ? tool.settings : undefined,
  };
}

/**
 * Convert IaC toolkit to SDK format
 * settings_config inferred from presence of settings if not explicitly set
 * Only resolved integrations are passed to SDK (not $ref)
 */
function iacToolkitToSdk(toolkit: IaCToolkit): SdkToolkit {
  return {
    ...toolkit,
    settings_config: toolkit.settings_config ?? Boolean(toolkit.settings),
    is_external: toolkit.is_external ?? false,
    tools: toolkit.tools.map((tool) => iacToolToSdk(tool)),
    settings: isResolvedIntegration(toolkit.settings) ? toolkit.settings : undefined,
  };
}

/**
 * Convert IaC MCP server to SDK format
 * Only resolved integrations are passed to SDK (not $ref)
 *
 * Note: Type assertion is required due to SDK type inconsistency between
 * MCPServerDetails (response type with config.command optional) and
 * AssistantCreateParams['mcp_servers'] (request type with config.command required).
 * The SDK handles validation at runtime, so we pass config as-is without modification.
 */
function iacMcpServerToSdk(mcp: IaCMcpServer): SdkMcpServer {
  const sanitized = sanitizeMcpServer(mcp);
  return {
    ...sanitized,
    enabled: sanitized.enabled ?? true,
    settings: isResolvedIntegration(sanitized.settings) ? sanitized.settings : undefined,
    mcp_connect_auth_token: isResolvedIntegration(sanitized.mcp_connect_auth_token)
      ? sanitized.mcp_connect_auth_token
      : undefined,
  } as SdkMcpServer;
}

/**
 * Convert IaC assistant resource to SDK create params.
 *
 * Note: This function expects all $ref references to be already resolved.
 * The configLoader.load() method resolves all $refs globally via resolveReferencesRecursive()
 * before this function is called. Unresolved $refs (if any) will be safely filtered out by
 * isResolvedIntegration() checks and converted to undefined, which is correct SDK behavior.
 *
 * @param assistant - Assistant resource with resolved integration references
 * @param projectName - Project name for the assistant
 * @param promptContent - System prompt content
 * @returns SDK-compatible assistant create parameters
 */
export function assistantResourceToCreateParams(
  assistant: AssistantResource,
  projectName: string,
  promptContent: string
): AssistantCreateParams {
  const {
    prompt: _prompt,
    config: _config,
    model,
    sub_assistants: _subAssistants,
    datasource_names: _datasourceNames,
    skills: _skills,
    toolkits,
    mcp_servers: mcpServers,
    ...sdkFields
  } = assistant;

  return {
    ...sdkFields,
    project: projectName,
    llm_model_type: model,
    system_prompt: promptContent,
    name: assistant.name,
    description: assistant.description,
    conversation_starters: assistant.conversation_starters || [],
    toolkits: (toolkits || []).map((toolkit) => iacToolkitToSdk(toolkit)),
    context: assistant.context || [],
    mcp_servers: (mcpServers || []).map((mcp) => iacMcpServerToSdk(mcp)),
    assistant_ids: assistant.assistant_ids || [],
    shared: assistant.shared ?? true,
    prompt_variables: assistant.prompt_variables || [],
  };
}
