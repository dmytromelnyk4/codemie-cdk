/*
 * Copyright © 2025 EPAM Systems, Inc. All Rights Reserved. All information contained herein is, and remains the
 * property of EPAM Systems, Inc. and/or its suppliers and is protected by international intellectual
 * property law. Dissemination of this information or reproduction of this material is strictly forbidden,
 * unless prior written permission is obtained from EPAM Systems, Inc
 */
import type {
  Assistant,
  AssistantCreateParams,
  BaseDataSourceCreateParams,
  BaseCodeParams,
  BaseConfluenceParams,
  BaseJiraParams,
  BaseGoogleParams,
  BaseFileParams,
  WorkflowCreateParams,
  Integration,
  DataSourceType,
  ToolDetails,
  ToolKitDetails,
  MCPServerDetails,
} from 'codemie-sdk';

export type AssistantWithSkills = Assistant & { skill_ids?: string[] };

export interface CodemieConfig {
  version: string;
  project: {
    name: string;
    description: string;
  };
  environment: {
    codemie_api_url: string;
    auth_server_url: string;
    auth_realm_name: string;
    // Either client credentials or username/password
    client_id?: string;
    client_secret?: string;
    username?: string;
    password?: string;
  };
  imported: {
    assistants: ImportedResource[];
    datasources: ImportedResource[];
    // Platform-managed skills referenced by name (not deployed by IaC)
    skills?: ImportedResource[];
    // Named integrations that can be referenced by alias in toolkits
    integrations: IntegrationDefinition[];
  };
  // Named tool definitions that can be referenced by alias in toolkits
  tool_definitions?: {
    [alias: string]: ToolDefinition;
  };
  datasource_defaults?: {
    [type: string]: Partial<DatasourceResource>; // Defaults by datasource type
  };
  resources: {
    assistants?: AssistantResource[];
    datasources?: DatasourceResource[];
    workflows?: WorkflowResource[];
    skills?: SkillResource[];
  };
}

export type IntegrationDefinition = Integration;

/**
 * Reference to a named integration in IaC config
 */
export interface IntegrationRef {
  $ref: string; // e.g., "imported.integrations.jira_main"
}

/**
 * Integration reference for IaC configurations
 * Can be:
 * - { $ref: string } - Reference to named integration
 * - Integration - Full integration object from SDK
 * - null
 */
export type IntegrationReference = IntegrationRef | Integration | null;

/**
 * IaC representation of a tool (extends SDK ToolDetails)
 * Override: settings can be $ref, settings_config optional
 */
export interface IaCTool extends Omit<ToolDetails, 'settings' | 'settings_config'> {
  settings_config?: boolean;
  settings?: IntegrationReference;
}

/**
 * IaC representation of a toolkit (extends SDK ToolKitDetails)
 * Override: settings can be $ref, tools use IaCTool, some fields optional
 */
export interface IaCToolkit extends Omit<ToolKitDetails, 'settings' | 'tools' | 'settings_config' | 'is_external'> {
  settings_config?: boolean;
  is_external?: boolean | null;
  tools: IaCTool[];
  settings?: IntegrationReference;
}

/**
 * IaC representation of MCP server (extends SDK MCPServerDetails)
 * Override: settings/mcp_connect_auth_token can be $ref, enabled optional
 */
export interface IaCMcpServer extends Omit<MCPServerDetails, 'settings' | 'mcp_connect_auth_token' | 'enabled'> {
  enabled?: boolean;
  settings?: IntegrationReference;
  mcp_connect_auth_token?: IntegrationReference;
}

export interface ToolDefinition {
  $ref: string;
  name: string; // Tool name (e.g., "generic_jira_tool")
  label?: string; // Human-readable label
  settings_config?: boolean;
  user_description?: string;
  settings?: IntegrationReference; // Can be $ref, full integration object, or null
  // Additional fields
  [key: string]: unknown;
}

export interface ImportedResource {
  name: string;
  id: string;
  type?: string;
}

/**
 * Assistant resource configuration (IaC layer)
 * Combines IaC-specific fields with all SDK AssistantCreateParams fields
 * Automatically inherits all new fields from SDK
 */
export interface AssistantResource
  extends Partial<
    Omit<AssistantCreateParams, 'project' | 'system_prompt' | 'llm_model_type' | 'toolkits' | 'mcp_servers'>
  > {
  // SDK fields inherited as optional - will be populated during deployment
  name: string; // Assistant name (unique identifier)
  description: string; // Assistant description (required in IaC and SDK)
  prompt: string; // Path to prompt file (loaded → system_prompt in SDK)
  model: string; // LLM model (mapped to llm_model_type in SDK)

  // Override SDK types with IaC types (support $ref in settings)
  toolkits?: IaCToolkit[];
  mcp_servers?: IaCMcpServer[];

  // Optional IaC-specific fields
  config?: string; // Optional build-time config file path
  sub_assistants?: string[]; // Assistant NAMES (resolved → assistant_ids during deployment)
  datasource_names?: string[]; // Datasource names (resolved → context entries during deployment)
  categories?: string[]; // Assistant categories (array of category names)
  skills?: string[]; // Skill NAMES (resolved → skill_ids during deployment)
}

/**
 * Base datasource configuration (IaC-specific fields only)
 */
interface BaseIaCDatasourceConfig {
  // Required IaC fields
  name: string; // Datasource name (unique identifier)
  description: string; // Datasource description (required in IaC and SDK)

  // IaC-specific optional fields
  $ref?: string; // Reference to datasource_defaults for inheriting common fields
  force_reindex?: boolean; // Force full reindex on deploy (even if unchanged)
}

/**
 * Base configuration for all datasource types (IaC + SDK fields)
 * Extends SDK BaseDataSourceCreateParams + adds IaC-specific fields
 */
interface BaseDatasourceConfig
  extends BaseIaCDatasourceConfig,
    Partial<Omit<BaseDataSourceCreateParams, 'project_name' | 'name' | 'description'>> {
  // SDK fields like type, shared_with_project, setting_id are inherited as optional
}

/**
 * Code datasource configuration (GitHub/GitLab/Bitbucket repositories)
 * Automatically inherits all new fields from SDK BaseCodeParams
 */
export interface CodeDatasourceResource extends BaseDatasourceConfig, Partial<BaseCodeParams> {
  type: typeof DataSourceType.CODE;
}

/**
 * Confluence datasource configuration
 * Automatically inherits all new fields from SDK BaseConfluenceParams
 */
export interface ConfluenceDatasourceResource extends BaseDatasourceConfig, Partial<BaseConfluenceParams> {
  type: typeof DataSourceType.CONFLUENCE;
}

/**
 * Jira datasource configuration
 * Automatically inherits all new fields from SDK BaseJiraParams
 */
export interface JiraDatasourceResource extends BaseDatasourceConfig, Partial<BaseJiraParams> {
  type: typeof DataSourceType.JIRA;
}

/**
 * Google Docs datasource configuration
 * Automatically inherits all new fields from SDK BaseGoogleParams
 */
export interface GoogleDatasourceResource extends BaseDatasourceConfig, Partial<BaseGoogleParams> {
  type: typeof DataSourceType.GOOGLE;
}

/**
 * File datasource configuration (uploaded files)
 * Automatically inherits all new fields from SDK BaseFileParams
 */
export interface FileDatasourceResource extends BaseDatasourceConfig, Partial<BaseFileParams> {
  type: typeof DataSourceType.FILE;
}

/**
 * Other/generic datasource configuration (for any other SDK datasource types)
 */
export interface OtherDatasourceResource extends BaseDatasourceConfig {
  type?: typeof DataSourceType.BEDROCK | typeof DataSourceType.JSON | typeof DataSourceType.PROVIDER;
}

/**
 * Discriminated union of all datasource types
 * Mirrors SDK DataSourceCreateParams structure
 * New datasource types in SDK will be automatically supported
 */
export type DatasourceResource =
  | CodeDatasourceResource
  | ConfluenceDatasourceResource
  | JiraDatasourceResource
  | GoogleDatasourceResource
  | FileDatasourceResource
  | OtherDatasourceResource;

/**
 * Skill resource configuration (IaC layer)
 */
export interface SkillResource {
  name: string; // Skill name (unique identifier)
  description: string; // Skill description
  file?: string; // Path to .skill.md file (loaded → content in SDK)
  categories?: string[];
  visibility?: string; // "project" | "public" (default: "project")
  source_dir?: string; // Folder of skill subdirectories to expand into skill resources
  ignore_file?: string; // Path to a YAML file listing subdirectory names to skip
  group?: string; // Passthrough grouping field (inherited, checksum-excluded)
  content?: string; // Skill content loaded from an expanded SKILL.md body
}

/**
 * Base Workflow configuration (IaC-specific fields only)
 */
interface BaseWorkflowConfig {
  // Required IaC fields
  name: string; // Workflow name (unique identifier)
  description: string; // Workflow description (required in IaC and SDK)

  // IaC-specific fields
  definition: string; // Path to workflow YAML file (loaded → yaml_config in SDK)
}

/**
 * Workflow resource configuration (IaC layer)
 * Combines IaC-specific fields with all SDK WorkflowCreateParams fields
 * Automatically inherits all new fields from SDK
 */
export interface WorkflowResource
  extends BaseWorkflowConfig,
    Partial<Omit<WorkflowCreateParams, 'project' | 'name' | 'description' | 'yaml_config'>> {
  // SDK fields like mode, shared, icon_url are inherited as optional
  // They will be populated during deployment with defaults if not specified
}

export interface AssistantConfig {
  // Build-time configuration only
  includes?: string[]; // Files to include in prompt
  placeholders?: Record<string, unknown>; // Placeholder values for compilation
  validation?: {
    max_length?: number;
    required_sections?: string[];
  };
  metadata?: Record<string, unknown>; // Additional metadata
}

export interface StateFile {
  version: string;
  project: string;
  lastSync: string | null;
  resources: {
    assistants: Record<string, AssistantState>; // Key is assistant NAME
    datasources: Record<string, DatasourceState>; // Key is datasource NAME
    workflows: Record<string, WorkflowState>; // Key is workflow NAME
    skills: Record<string, SkillState>; // Key is skill NAME
  };
}

export interface AssistantState {
  id: string; // Platform-assigned UUID
  lastDeployed: string;
  promptChecksum: string;
  configChecksum: string;
}

export interface DatasourceState {
  id: string; // Platform-assigned UUID
  lastDeployed: string;
  configChecksum: string; // Checksum of datasource configuration
}

export interface WorkflowState {
  id: string; // Platform-assigned UUID
  lastDeployed: string;
  workflowYamlChecksum: string; // Checksum of workflow YAML file content
  configChecksum: string; // Checksum of metadata (name, description, mode, etc.)
}

export interface SkillState {
  id: string; // Platform-assigned UUID
  lastDeployed: string;
  contentChecksum: string; // Checksum of skill content (.skill.md)
  configChecksum: string; // Checksum of skill config (name, description, categories, etc.)
  group?: string; // Group label copied from the config entry (selection only, never change detection)
  companionFilesChecksum?: string; // Aggregate checksum of companion files metadata + content hashes
  companionFileHashes?: Record<string, string>; // Companion file path -> content hash (never file bodies)
}

// ===========================
// Workflow YAML Structure
// ===========================

export interface WorkflowYaml {
  assistants?: WorkflowAssistantReference[];
  states: WorkflowStateDefinition[];
}

export interface WorkflowAssistantReference {
  id: string; // Local ID for referencing in states
  assistant_id?: string; // Codemie UUID (resolved during deploy)
  assistant_name?: string; // Assistant name from codemie.yaml (name-based)

  // Inline assistant fields (defined directly in workflow)
  model?: string; // LLM model (e.g., gpt-4o-mini)
  name?: string; // Inline assistant name
  system_prompt?: string; // Inline assistant prompt
}

export interface WorkflowStateDefinition {
  id: string;
  assistant_id: string; // References WorkflowAssistantReference.id
  task: string;
  output_schema: string;
  next?: {
    state_id: string;
  };
}

export interface Change {
  type: 'create' | 'update' | 'no-change' | 'delete';
  resourceType: 'assistant' | 'datasource' | 'workflow' | 'skill';
  name: string;
  details?: string;
}
