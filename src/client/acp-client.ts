import { EventEmitter } from "node:events";
import { AgentConnection, ConnectionEvent, TurnController } from "../connection/interface.js";
import { AgentAdapter } from "../driver-adapter/interface.js";
import { SessionManager, SessionInfo } from "../session/interface.js";
import { ClientMethodRouter } from "../client-methods/router.js";
import { ClientInterceptors, HookPoint } from "../hook-gate/interface.js";
import { SessionError } from "../core/errors.js";
import type { InitializeResult } from "../connection/interface.js";
import type { ClientCapabilities, McpServerConfig } from "../core/types.js";
import type { ExtensionMethod } from "../client-methods/extension-loader.js";
import { ExtensionMcpServer } from "../client-methods/extension-mcp-server.js";
import type { AuthExecutor } from "../auth/interface.js";

export type ClientState =
  | "disconnected"
  | "initializing"
  | "authenticated"
  | "ready"
  | "busy"
  | "shutting_down";

export interface AcpClientOptions {
  adapter: AgentAdapter;
  connection: AgentConnection;
  authLayer: AuthExecutor;
  sessionManager: SessionManager;
  methodRouter: ClientMethodRouter;
  interceptors?: ClientInterceptors;
  verbose?: boolean;
  experimentalCapabilities?: Record<string, any>;
  /** Workspace root used for FS boundary + eval FS jail. */
  sandboxDir?: string;
  extensionMethods?: ExtensionMethod[];
}

export class AcpClient extends EventEmitter {
  private adapter: AgentAdapter;
  private connection: AgentConnection;
  private authLayer: AuthExecutor;
  private sessionManager: SessionManager;
  private methodRouter: ClientMethodRouter;
  private interceptors?: ClientInterceptors;
  private verbose: boolean;
  private experimentalCapabilities?: Record<string, any>;
  private sandboxDir?: string;
  private extensionMethods: ExtensionMethod[];
  private extensionMcpServer: ExtensionMcpServer | null = null;

  private initialized = false;
  private authenticated = false;
  private authMethods: any[] = [];
  private currentSession: SessionInfo | null = null;
  private abortController: AbortController | null = null;

  private status: ClientState = "disconnected";

  constructor(options: AcpClientOptions) {
    super();
    this.adapter = options.adapter;
    this.connection = options.connection;
    this.authLayer = options.authLayer;
    this.sessionManager = options.sessionManager;
    this.methodRouter = options.methodRouter;
    this.interceptors = options.interceptors;
    this.verbose = options.verbose ?? false;
    this.experimentalCapabilities = options.experimentalCapabilities;
    this.sandboxDir = options.sandboxDir;
    this.extensionMethods = options.extensionMethods ?? [];

    // Connect the router to the connection
    this.connection.setMethodRouter(this.methodRouter);
  }

  // Type-safe Event Emitter Overloads
  override emit(event: "stateChange", newState: ClientState, oldState: ClientState): boolean;
  override emit(event: "event", connEvent: ConnectionEvent): boolean;
  override emit(
    event:
      | "agent_message_chunk"
      | "agent_thought_chunk"
      | "tool_call"
      | "tool_call_update"
      | "stderr"
      | "agentMessage",
    payload: any
  ): boolean;
  override emit(event: HookPoint, payload: any): boolean;
  override emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  override on(
    event: "stateChange",
    listener: (newState: ClientState, oldState: ClientState) => void
  ): this;
  override on(event: "event", listener: (connEvent: ConnectionEvent) => void): this;
  override on(
    event:
      | "agent_message_chunk"
      | "agent_thought_chunk"
      | "tool_call"
      | "tool_call_update"
      | "stderr"
      | "agentMessage",
    listener: (payload: any) => void
  ): this;
  override on(event: HookPoint, listener: (payload: any) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override once(
    event: "stateChange",
    listener: (newState: ClientState, oldState: ClientState) => void
  ): this;
  override once(event: "event", listener: (connEvent: ConnectionEvent) => void): this;
  override once(
    event:
      | "agent_message_chunk"
      | "agent_thought_chunk"
      | "tool_call"
      | "tool_call_update"
      | "stderr"
      | "agentMessage",
    listener: (payload: any) => void
  ): this;
  override once(event: HookPoint, listener: (payload: any) => void): this;
  override once(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  getState(): ClientState {
    return this.status;
  }

  private setState(newState: ClientState): void {
    const oldState = this.status;
    if (oldState !== newState) {
      this.status = newState;
      if (this.verbose) {
        console.log(`[ClientState] ${oldState} -> ${newState}`);
      }
      this.emit("stateChange", newState, oldState);
    }
  }

  getAdapterRegistry() {
    return this.adapter;
  }

  getCurrentSession(): SessionInfo | null {
    return this.currentSession;
  }

  async initialize(customCapabilities?: Partial<ClientCapabilities>): Promise<InitializeResult> {
    this.setState("initializing");
    const agentId = this.adapter.agentId;
    this.emit("pre:connect", { point: "pre:connect", agentId });

    const spawnOptions = this.adapter.resolveCommand();
    const env = this.adapter.resolveEnv();

    await this.connection.connect({
      ...spawnOptions,
      env,
      cwd: this.sandboxDir,
      jailRoot: this.sandboxDir,
      verbose: this.verbose,
    });

    this.emit("post:connect", { point: "post:connect", agentId });
    this.emit("pre:initialize", { point: "pre:initialize", agentId });

    const clientCapabilities: ClientCapabilities = {
      fs: { readTextFile: true, writeTextFile: true, listDirectory: true },
      terminal: true,
      experimental: {
        ...this.experimentalCapabilities,
        ...customCapabilities?.experimental,
      },
      ...customCapabilities,
    };

    const result = await this.connection.initialize({
      protocolVersion: 1,
      clientCapabilities,
      clientInfo: { name: "acp-client-prototype", version: "2.0.0" },
    });

    this.initialized = true;
    this.authMethods = result.authMethods || [];
    this.abortController = new AbortController();

    this.emit("post:initialize", { point: "post:initialize", agentId, data: result });

    // Setup event forwarding
    this.setupEventForwarding(this.abortController.signal);

    // If no authenticate is needed, transition to authenticated
    const strategy = this.adapter.resolveAuthStrategy();
    if (strategy === "none" || this.authMethods.length === 0) {
      this.authenticated = true;
      this.setState("authenticated");
    }

    return result;
  }

  private setupEventForwarding(signal: AbortSignal) {
    (async () => {
      try {
        for await (const event of this.connection.onEvent(signal)) {
          // Apply output interceptor callback
          let finalEvent = event;
          if (this.interceptors?.output) {
            const intercepted = await this.interceptors.output(event);
            if (intercepted === null) continue;
            finalEvent = intercepted;
          }

          this.emit("event", finalEvent);
          this.emit(finalEvent.type as any, finalEvent.payload);

          if (finalEvent.type === "agent_message_chunk")
            this.emit("agentMessage", finalEvent.payload);
          if (finalEvent.type === "stderr") this.emit("stderr", finalEvent.payload);
        }
      } catch (err) {
        if (!signal.aborted && this.verbose) console.error("[AcpClient] Event loop error:", err);
      }
    })().catch((err) => {
      if (this.verbose) console.error("[AcpClient] Event loop error:", err);
    });
  }

  async authenticate(): Promise<void> {
    this.ensureInitialized();
    const agentId = this.adapter.agentId;
    this.emit("pre:authenticate", { point: "pre:authenticate", agentId });

    const strategy = this.adapter.resolveAuthStrategy();
    if (this.verbose) console.log(`[Auth] Using strategy: ${strategy}`);

    const credential = await this.authLayer.execute(strategy, this.authMethods, this.verbose);

    if (credential) {
      if (this.verbose) console.log(`[Auth] Authenticating with method: ${credential.methodId}`);
      await this.connection.authenticate(credential.methodId, credential);
      if (this.verbose) console.log(`[Auth] Authentication successful`);
    } else {
      if (this.verbose) console.log(`[Auth] No credential obtained, proceeding as unauthenticated`);
    }

    this.authenticated = true;
    this.setState("authenticated");
    this.emit("post:authenticate", { point: "post:authenticate", agentId });
  }

  async createSession(cwd: string, mcpServers: McpServerConfig[] = []): Promise<SessionInfo> {
    this.ensureInitialized();
    if (!this.authenticated) await this.authenticate();

    const agentId = this.adapter.agentId;
    this.emit("pre:session:create", { point: "pre:session:create", agentId, data: { cwd } });

    const extensionMcpServers = await this.getExtensionMcpServers();
    const sessionRecord = await this.connection.createSession(cwd, [
      ...mcpServers,
      ...extensionMcpServers,
    ]);
    this.currentSession = {
      sessionId: sessionRecord.sessionId,
      cwd,
      agentId,
    };

    this.emit("post:session:create", {
      point: "post:session:create",
      agentId,
      data: this.currentSession,
    });
    this.setState("ready");
    return this.currentSession;
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: McpServerConfig[] = []
  ): Promise<SessionInfo> {
    this.ensureInitialized();
    if (!this.authenticated) await this.authenticate();

    const agentId = this.adapter.agentId;
    this.emit("pre:session:load", {
      point: "pre:session:load",
      agentId,
      data: { sessionId, cwd },
    });

    const extensionMcpServers = await this.getExtensionMcpServers();
    const sessionRecord = await this.connection.loadSession(sessionId, cwd, [
      ...mcpServers,
      ...extensionMcpServers,
    ]);
    this.currentSession = {
      sessionId: sessionRecord.sessionId,
      cwd,
      agentId,
    };

    this.emit("post:session:load", {
      point: "post:session:load",
      agentId,
      data: this.currentSession,
    });
    this.setState("ready");
    return this.currentSession;
  }

  async sendPrompt(message: string): Promise<TurnController> {
    this.ensureInitialized();
    if (!this.currentSession) throw new SessionError("No active session");

    const agentId = this.adapter.agentId;
    this.emit("pre:prompt", { point: "pre:prompt", agentId, data: { message } });

    this.setState("busy");

    const turn = await this.connection.sendPrompt(this.currentSession.sessionId, message);

    const originalSymbolIterator = turn[Symbol.asyncIterator];
    const self = this;

    const wrappedTurn: TurnController = {
      cancel: () => turn.cancel(),
      get result() {
        return turn.result;
      },
      [Symbol.asyncIterator]() {
        const iterator = originalSymbolIterator.call(turn);
        return {
          async next() {
            try {
              const res = await iterator.next();
              if (res.done) {
                self.setState("ready");
              }
              return res;
            } catch (err) {
              self.setState("ready");
              throw err;
            }
          },
          async return(value) {
            self.setState("ready");
            if (iterator.return) return iterator.return(value);
            return { done: true, value };
          },
          async throw(err) {
            self.setState("ready");
            if (iterator.throw) return iterator.throw(err);
            throw err;
          },
        };
      },
    };

    return wrappedTurn;
  }

  async shutdown(): Promise<void> {
    this.setState("shutting_down");
    const agentId = this.adapter.agentId;
    this.abortController?.abort();
    this.emit("pre:disconnect", { point: "pre:disconnect", agentId });
    try {
      await this.connection.disconnect();
    } finally {
      if (this.extensionMcpServer) {
        await this.extensionMcpServer.stop();
        this.extensionMcpServer = null;
      }
    }
    this.emit("post:disconnect", { point: "post:disconnect", agentId });
    this.initialized = false;
    this.authenticated = false;
    this.currentSession = null;
    this.abortController = null;
    this.setState("disconnected");
  }

  private ensureInitialized() {
    if (!this.initialized) throw new Error("Client not initialized");
  }

  private async getExtensionMcpServers(): Promise<McpServerConfig[]> {
    if (this.extensionMethods.length === 0) return [];

    if (!this.extensionMcpServer) {
      this.extensionMcpServer = new ExtensionMcpServer(this.extensionMethods, (method, args) =>
        this.methodRouter.route(method, args)
      );
    }

    const url = await this.extensionMcpServer.start();
    return [
      {
        name: "acp-client-extension-methods",
        type: "sse",
        url,
        headers: [],
      },
    ];
  }
}
