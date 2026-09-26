import dotenv from "dotenv";
dotenv.config();

export { AcpClientBuilder, ConnectionFactory } from "./client/builder.js";
export { AcpClient, ClientState, AcpClientOptions } from "./client/acp-client.js";
export { ADAPTER_REGISTRY } from "./driver-adapter/registry.js";
export { AgentAdapter } from "./driver-adapter/interface.js";
export { AcpConnection } from "./connection/acp-connection.js";
export { PtyConnection } from "./connection/pty-connection.js";
export {
  AgentConnection,
  ConnectionEvent,
  ConnectionOptions,
  ConnectionType,
  InitializeResult,
  SessionRecord,
  TurnController,
} from "./connection/interface.js";
export {
  PtyOutputParser,
  PtyParserContext,
  PtyParserResult,
  PtyStream,
  PtyTurnResult,
} from "./connection/pty-parser.js";
export {
  AiderPtyParser,
  DefaultPtyParser,
  parseAiderEditBlocks,
} from "./connection/pty-parsers/index.js";
export { AuthLayer } from "./auth/auth-layer.js";
export { AuthCredential, AuthExecutor, AuthStrategy, AuthStrategyType } from "./auth/interface.js";
export { MemorySessionStore } from "./session/memory-session-store.js";
export { SessionInfo, SessionManager } from "./session/interface.js";
export { ClientMethodRouter } from "./client-methods/router.js";
export { ClientMethodHandler } from "./client-methods/interface.js";
export { ExtensionMethod, loadExtensionConfig } from "./client-methods/extension-loader.js";
export { FileSystemHandler } from "./client-methods/filesystem-handler.js";
export { PermissionHandler } from "./client-methods/permission-handler.js";
export { TerminalHandler, TerminalHandlerOptions } from "./client-methods/terminal-handler.js";
export * from "./hook-gate/interface.js";
export type {
  AgentCapabilities,
  AgentMessageChunkUpdate,
  ArtifactRef,
  AuthMethod,
  AuthenticateRequest,
  AvailableCommandsUpdate,
  ClientCapabilities,
  ConfigOptionUpdate,
  ContentBlock,
  ContextPackRef,
  FileLocation,
  FileReadRequest,
  FileWriteRequest,
  ImageContent,
  InitializeRequest,
  InitializeResponse,
  JsonRpcError,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpEnvVariable,
  McpHttpHeader,
  McpServerConfig,
  PermissionRequest,
  PermissionResponse,
  PlanEntry,
  PlanUpdate,
  PromptResponse,
  RuntimeCapabilities,
  SessionInfoUpdate,
  SessionNewRequest,
  SessionNewResponse,
  SessionNotification,
  SessionPromptRequest,
  SessionUpdate,
  TerminalCreateRequest,
  TextContent,
  ToolCallUpdate,
  ToolCallUpdateUpdate,
  ToolContent,
  ToolKind,
  UsageUpdate,
  UserMessageChunkUpdate,
} from "./core/types.js";
export * from "./core/errors.js";

// Driver exports
export * from "./driver/interface.js";
export { MockDriver } from "./driver/mock-driver.js";
