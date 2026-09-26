import type {
  ClientCapabilities,
  AuthMethod,
  AgentCapabilities,
  McpServerConfig,
} from "../core/types.js";

export type ConnectionType = "acp" | "pty";

export interface ConnectionOptions {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  verbose?: boolean;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: AgentCapabilities;
  agentInfo?: {
    name: string;
    version: string;
  };
  authMethods?: AuthMethod[];
}

export interface SessionRecord {
  sessionId: string;
}

export interface ConnectionEvent {
  type:
    | "user_message_chunk"
    | "agent_message_chunk"
    | "agent_thought_chunk"
    | "tool_call"
    | "tool_call_update"
    | "plan"
    | "available_commands_update"
    | "current_mode_update"
    | "config_option_update"
    | "session_info_update"
    | "usage_update"
    | "permission_request"
    | "disconnect"
    | "stderr";
  payload: any;
}

/**
 * Interface for a single prompt turn's execution and result.
 */
export interface TurnController extends AsyncIterable<ConnectionEvent> {
  cancel(): Promise<void>;
  readonly result: Promise<any>;
}

export interface AgentConnection {
  readonly type: ConnectionType;
  readonly isConnected: boolean;

  connect(options: ConnectionOptions): Promise<void>;
  disconnect(): Promise<void>;

  initialize(params: {
    protocolVersion: number;
    clientCapabilities: ClientCapabilities;
    clientInfo?: { name: string; version: string };
  }): Promise<InitializeResult>;
  authenticate(methodId: string, authMethod: any): Promise<void>;
  createSession(cwd: string, mcpServers?: McpServerConfig[]): Promise<SessionRecord>;
  loadSession(
    sessionId: string,
    cwd: string,
    mcpServers?: McpServerConfig[]
  ): Promise<SessionRecord>;
  sendPrompt(sessionId: string, message: string): Promise<TurnController>;
  cancel(sessionId: string): Promise<void>;

  setMethodRouter(router: { route(method: string, params: any): Promise<any> }): void;

  /**
   * Global event stream for the connection (e.g. out-of-band notifications)
   */
  onEvent(signal?: AbortSignal): AsyncIterable<ConnectionEvent>;
}
