/**
 * ACP (Agent Client Protocol) Core Types
 * Based on ACP Specification v1 - https://agentclientprotocol.com
 */

// ── JSON-RPC Base ──

export interface JsonRpcRequest<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: T;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: JsonRpcError;
}

export interface JsonRpcNotification<T = unknown> {
  jsonrpc: "2.0";
  method: string;
  params: T;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ── Initialize ──

export interface ClientCapabilities {
  fs?: {
    readTextFile?: boolean;
    writeTextFile?: boolean;
    listDirectory?: boolean;
  };
  terminal?: boolean;
  /** Custom or experimental client-provided capabilities */
  experimental?: Record<string, any>;
  [key: string]: any;
}

export interface InitializeRequest {
  protocolVersion: number;
  clientCapabilities: ClientCapabilities;
  clientInfo?: {
    name: string;
    version: string;
  };
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  mcpCapabilities?: {
    http?: boolean;
    sse?: boolean;
  };
  sessionCapabilities?: {
    close?: Record<string, never>;
    resume?: Record<string, never>;
    modes?: Record<string, never>;
    commands?: Record<string, never>;
  };
}

export interface InitializeResponse {
  protocolVersion: number;
  agentCapabilities: AgentCapabilities;
  agentInfo?: {
    name: string;
    version: string;
  };
  authMethods?: AuthMethod[];
}

// ── Auth ──

export interface AuthMethod {
  id: string;
  name: string;
  description?: string | null;
  _meta?: Record<string, unknown>;
}

export interface AuthenticateRequest {
  methodId: string;
  authMethod: {
    id: string;
    name: string;
    description: string;
  };
}

// ── Session ──

export interface SessionNewRequest {
  cwd: string;
  mcpServers?: McpServerConfig[];
}

export interface SessionNewResponse {
  sessionId: string;
}

export interface SessionPromptRequest {
  sessionId: string;
  prompt: ContentBlock[];
}

export interface PromptResponse {
  stopReason: "end_turn" | "max_tokens" | "tool_use" | "cancelled" | "error" | string;
}

export interface McpHttpHeader {
  name: string;
  value: string;
}

export interface McpEnvVariable {
  name: string;
  value: string;
}

export type McpServerConfig =
  | {
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string> | McpEnvVariable[];
    }
  | {
      name: string;
      type: "http" | "sse";
      url: string;
      headers: McpHttpHeader[];
    };

// ── Content Blocks ──

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64";
    mediaType: string;
    data: string;
  };
}

export type ContentBlock = TextContent | ImageContent;

// ── Session Update (session/update notification) ──

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
  _meta?: Record<string, unknown>;
}

export type SessionUpdate =
  | UserMessageChunkUpdate
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | ToolCallUpdate
  | ToolCallUpdateUpdate
  | PlanUpdate
  | AvailableCommandsUpdate
  | CurrentModeUpdate
  | ConfigOptionUpdate
  | SessionInfoUpdate
  | UsageUpdate;

export interface UserMessageChunkUpdate {
  sessionUpdate: "user_message_chunk";
  content: ContentBlock;
}

export interface AgentMessageChunkUpdate {
  sessionUpdate: "agent_message_chunk";
  content: ContentBlock;
}

export interface AgentThoughtChunkUpdate {
  sessionUpdate: "agent_thought_chunk";
  content: ContentBlock;
}

/**
 * 工具类别，取自 ACP 的 `ToolKind`。
 *
 * 这是**分类**不是工具名：`execute` 既可能是 Bash 也可能是 PowerShell。
 * 真正的工具名在 adapter 的 `_meta` 里（如 claude 的 `_meta.claudeCode.toolName`），
 * 不属于协议标准字段，所以不能拿 kind 当名字用。
 */
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export interface ToolCallUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: "pending" | "in_progress";
  rawInput?: unknown;
  locations?: FileLocation[];
}

export interface ToolCallUpdateUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status: "completed" | "failed" | "in_progress";
  content?: ToolContent[];
  rawOutput?: unknown;
}

export interface FileLocation {
  path: string;
  line?: number;
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "diff"; path: string; oldText: string; newText: string }
  | { type: "terminal"; command: string; output: string };

export interface PlanUpdate {
  sessionUpdate: "plan";
  entries: PlanEntry[];
}

export interface PlanEntry {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  priority?: number;
}

export interface AvailableCommandsUpdate {
  sessionUpdate: "available_commands_update";
  availableCommands: Array<{
    name: string;
    description?: string;
  }>;
}

export interface CurrentModeUpdate {
  sessionUpdate: "current_mode_update";
  currentModeId: string;
}

export interface ConfigOptionUpdate {
  sessionUpdate: "config_option_update";
  configOptions: Array<{
    id: string;
    value: unknown;
  }>;
}

export interface SessionInfoUpdate {
  sessionUpdate: "session_info_update";
  title?: string;
  updatedAt?: string;
}

/**
 * 会话级上下文水位与累积成本。
 *
 * 协议标注 **UNSTABLE**：不属于正式规范，随时可能改。用作观测可以，
 * 不要当成稳定契约来依赖。
 */
export interface UsageUpdate {
  sessionUpdate: "usage_update";
  /** 当前上下文里的 token 数。 */
  used: number;
  /** 上下文窗口总容量（token）。 */
  size: number;
  /** 会话累积成本。实测 adapter 未必每条都带。 */
  cost?: { amount: number; currency: string };
}

// ── Permission ──

export interface PermissionRequest {
  requestId: string;
  title: string;
  message: string;
  options: Array<{
    optionId: string;
    label: string;
  }>;
}

export interface PermissionResponse {
  outcome: { type: "selected" };
  optionId: string;
}

// ── Client Methods (Agent calls these on Client) ──

export interface FileReadRequest {
  path: string;
}

export interface FileWriteRequest {
  path: string;
  content: string;
}

export interface TerminalCreateRequest {
  command: string;
  cwd?: string;
}

// ── Agent Registry Types ──

export type AuthStrategy = "none" | "env-auto" | "pre-configured" | "interactive";

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  authStrategy: AuthStrategy;
  authEnvVars?: string[];
  optionalCapabilities?: {
    sessionClose?: boolean;
    sessionLoad?: boolean;
  };
  /** Hint shown when the agent binary is not found in PATH */
  installHint?: string;
}

// ── Runtime Capabilities ──

export interface RuntimeCapabilities {
  sessionClose: boolean;
  sessionLoad: boolean;
  permissionRequests: boolean;
  mcpHttp: boolean;
  mcpSse: boolean;
  imageInput: boolean;
  audioInput: boolean;
  embeddedContext: boolean;
  modes: boolean;
  commands: boolean;
}

// ── Driver Contract Types & Aliases ──

export type TaskId = string;
export type RunId = string;
export type Timestamp = string;
export type SchemaVersion = string;
export type DriverSessionId = string;
export type DriverId = string;

export const SCHEMA_VERSION = "v0";

export function createId(prefix: string): string {
  const rand = Math.random().toString(36).substring(2, 10);
  return `${prefix}-${rand}`;
}

export function nowTimestamp(): string {
  return new Date().toISOString();
}

export type ArtifactType =
  | "patch"
  | "diff"
  | "test_log"
  | "review"
  | "decision_packet"
  | "checkpoint"
  | "context"
  | "transcript"
  | "driver_result"
  | "audit"
  | "merge_authorization";

export interface ArtifactContent {
  kind: "text" | "file" | "patch" | "metadata";
  content_ref: string;
  target_path?: string;
  media_type?: string;
}

export interface ArtifactRef {
  artifact_id: string;
  type: ArtifactType;
  uri: string;
  sha256?: string;
  producer_id: string;
  task_id?: string;
  metadata?: Record<string, unknown>;
  content?: ArtifactContent;
  created_at: string;
  schema_version: string;
}

export interface ContextPackRef {
  context_pack_id: string;
  uri: string;
  task_id?: string;
  schema_version: string;
}
