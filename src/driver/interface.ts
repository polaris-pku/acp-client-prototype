import type {
  ArtifactRef,
  ContextPackRef,
  DriverId,
  DriverSessionId,
  McpServerConfig,
  RunId,
  SchemaVersion,
  TaskId,
  Timestamp,
  ToolKind,
} from "../core/types.js";

// Re-export core references for backward compatibility and downstream modules
export type { ArtifactRef, ContextPackRef, ArtifactType } from "../core/types.js";

export interface DriverCapabilities {
  supports_acp_extension: boolean;
  supports_structured_output: boolean;
  supports_session_load: boolean;
  supports_tool_events: boolean;
  supports_permission_events: boolean;
}

export interface DriverPrompt {
  task_id: TaskId;
  run_id: RunId;
  prompt: string;
  session_id?: DriverSessionId;
  workspace_path?: string;
  /** MCP servers the agent should connect to for this session. */
  mcp_servers?: McpServerConfig[];
  context_pack_ref?: ContextPackRef;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

/**
 * 一轮 prompt 的 token 用量，来自 ACP 的 `PromptResponse.usage`。
 *
 * 协议标注 **UNSTABLE**。字段全部转成 snake_case 以对齐本仓库的契约命名，
 * 且除三个总量外都是可选——实测 adapter 未必都填（如 claude 不填 thought_tokens）。
 */
export interface DriverUsage {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  thought_tokens?: number;
  cached_read_tokens?: number;
  cached_write_tokens?: number;
}

export interface DriverToolEvent {
  tool_event_id: string;
  /**
   * 工具名。
   *
   * 注意：当前实现填的是 ACP 的 `kind` 分类（read / edit / execute…），
   * **不是真正的工具名**。真名在 adapter 的 `_meta` 里，不属于协议标准字段。
   * 改语义会波及消费方前端快照，尚未变更。
   */
  tool_name: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  summary: string;
  /** 工具分类。与 `tool_name` 并存，便于消费方在真名不可得时自行降级。 */
  kind?: ToolKind;
  /** 该工具触碰的文件路径（协议 `locations`）。 */
  locations?: string[];
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface DriverError {
  code: string;
  message: string;
  retryable: boolean;
}

export type DriverRunStatus = "succeeded" | "failed" | "cancelled" | "interrupted";

export interface DriverRunResult {
  driver_run_result_id: string;
  session_id: DriverSessionId;
  status: DriverRunStatus;
  response: string;
  artifacts: ArtifactRef[];
  transcript_ref: ArtifactRef;
  tool_events: DriverToolEvent[];
  /**
   * 本轮 token 用量。
   *
   * 可选：adapter 未上报时为 undefined。这是新增字段——消费方的
   * `assertDriverRunResult` 只做必填项存在性校验，不拒绝额外字段。
   */
  usage?: DriverUsage;
  diagnostics: {
    driver_id: DriverId;
    duration_ms: number;
    notes: string[];
  };
  error?: DriverError;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface DriverRuntimeHandle {
  driver_id: DriverId;
  session_id: DriverSessionId;
  capabilities: DriverCapabilities;
  sendPrompt(input: DriverPrompt): Promise<DriverRunResult>;
  interrupt(reason: string): Promise<void>;
  collectTranscript(): Promise<ArtifactRef>;
}
