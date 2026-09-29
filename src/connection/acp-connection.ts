import { ClientSideConnection, ndJsonStream, RequestError } from "@agentclientprotocol/sdk";
import type { Client, SessionNotification } from "@agentclientprotocol/sdk";
import spawn from "cross-spawn";
import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter, on } from "node:events";
import { Readable, Writable } from "node:stream";
import {
  AgentConnection,
  ConnectionOptions,
  ConnectionEvent,
  InitializeResult,
  SessionRecord,
  TurnController,
} from "./interface.js";
import { AgentSpawnError, TransportError } from "../core/errors.js";
import type { ClientCapabilities, McpServerConfig } from "../core/types.js";
import {
  processSandboxEnabled,
  resolveProcessSandboxRoot,
  wrapSpawnForProcessSandbox,
} from "../security/eval-fs-jail.js";

export class AcpConnection implements AgentConnection {
  readonly type = "acp";
  private process: ChildProcess | null = null;
  private sdkConn: ClientSideConnection | null = null;
  private eventEmitter = new EventEmitter();
  private methodRouter: { route(method: string, params: any): Promise<any> } | null = null;

  private verbose = false;

  get isConnected(): boolean {
    return !!this.sdkConn;
  }

  setMethodRouter(router: { route(method: string, params: any): Promise<any> }): void {
    this.methodRouter = router;
  }

  async connect(options: ConnectionOptions): Promise<void> {
    this.verbose = options.verbose ?? false;
    const mergedEnv = { ...process.env, ...options.env };
    let command = options.command;
    let args = options.args;
    let cwd = options.cwd;
    let env: Record<string, string | undefined> = mergedEnv;

    if (processSandboxEnabled()) {
      const jailRoot = resolveProcessSandboxRoot(options.jailRoot ?? options.cwd);
      if (!jailRoot) {
        throw new AgentSpawnError(
          "ACP_PROCESS_SANDBOX=1 requires ConnectionOptions.jailRoot (or ACP_PROCESS_SANDBOX_ROOT)"
        );
      }
      try {
        const jailed = wrapSpawnForProcessSandbox({
          command: options.command,
          args: options.args,
          cwd: options.cwd,
          jailRoot,
          env: mergedEnv,
        });
        command = jailed.command;
        args = jailed.args;
        cwd = jailed.cwd;
        env = { ...mergedEnv, ...jailed.env };
        if (this.verbose) {
          console.error(`[ProcessSandbox] spawning agent under bwrap root=${jailRoot}`);
        }
      } catch (error) {
        throw new AgentSpawnError(
          `Failed to enable eval FS jail: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    this.process = spawn(command, args, {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!this.process.stdin || !this.process.stdout) {
      throw new AgentSpawnError("Failed to open stdin/stdout for agent process");
    }

    if (this.verbose) {
      const agentLabel = `${options.command} ${options.args.join(" ")}`;
      this.process.stdout.on("data", (chunk) => {
        const text =
          Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString()
            : String(chunk);
        console.log(`\x1b[32m[Raw Output from ${agentLabel}]\x1b[0m ${text.trim()}`);
      });
      this.process.stderr?.on("data", (chunk) => {
        const text =
          Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString()
            : String(chunk);
        console.log(`\x1b[31m[Raw Stderr from ${agentLabel}]\x1b[0m ${text.trim()}`);
      });
      const originalWrite = this.process.stdin.write.bind(this.process.stdin);
      this.process.stdin.write = (chunk: any, encoding?: any, cb?: any) => {
        const text =
          Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString()
            : String(chunk);
        console.log(`\x1b[34m[Raw Input to ${agentLabel}]\x1b[0m ${text.trim()}`);
        return originalWrite(chunk, encoding, cb);
      };
    }

    // Wrap stdin/stdout into Web Streams
    const writable = Writable.toWeb(this.process.stdin) as WritableStream<Uint8Array>;
    const readable = Readable.toWeb(this.process.stdout) as ReadableStream<Uint8Array>;

    const stream = ndJsonStream(writable, readable);

    // Define a simple client implementation to handle callbacks from agent
    const clientImpl: Client = {
      sessionUpdate: async (params: SessionNotification) => {
        const updateType = params.update.sessionUpdate;
        this.emitEvent(updateType as any, params);
      },
      requestPermission: async (params) => {
        return await this.routeClientMethod("session/request_permission", params);
      },
      readTextFile: async (params) => {
        return await this.routeClientMethod("fs/read_text_file", params);
      },
      writeTextFile: async (params) => {
        return await this.routeClientMethod("fs/write_text_file", params);
      },
      createTerminal: async (params) => {
        return await this.routeClientMethod("terminal/create", params);
      },
      terminalOutput: async (params) => {
        return await this.routeClientMethod("terminal/output", params);
      },
      waitForTerminalExit: async (params) => {
        return await this.routeClientMethod("terminal/wait_for_exit", params);
      },
      killTerminal: async (params) => {
        return await this.routeClientMethod("terminal/kill", params);
      },
      releaseTerminal: async (params) => {
        return await this.routeClientMethod("terminal/release", params);
      },
      extMethod: async (method: string, params: Record<string, unknown>) => {
        return await this.routeClientMethod(method, params);
      },
    };

    this.sdkConn = new ClientSideConnection(() => clientImpl, stream);

    this.process.on("exit", (code, signal) => {
      this.emitEvent("disconnect", { code, signal });
      this.sdkConn = null;
    });

    this.process.stderr?.on("data", (data) => {
      this.emitEvent("stderr", data.toString());
    });
  }

  private emitEvent(type: ConnectionEvent["type"], payload: any) {
    const event: ConnectionEvent = { type, payload };
    this.eventEmitter.emit("event", event);
  }

  private async routeClientMethod(method: string, params: any): Promise<any> {
    if (!this.methodRouter) {
      throw RequestError.methodNotFound(method);
    }

    return await this.methodRouter.route(method, params);
  }

  async disconnect(): Promise<void> {
    if (this.process) {
      const pid = this.process.pid;
      if (process.platform === "win32" && pid) {
        try {
          // On Windows, killing the parent wrapper process (like npx.cmd) doesn't kill the child.
          // We must force kill the entire process tree using taskkill.
          spawnSync("taskkill", ["/F", "/T", "/PID", pid.toString()]);
        } catch (e) {
          if (this.verbose) {
            console.error(`Failed to taskkill process tree for PID ${pid}:`, e);
          }
        }
      } else {
        this.process.kill();
      }
      this.process = null;
    }
    this.sdkConn = null;
  }

  async initialize(params: {
    protocolVersion: number;
    clientCapabilities: ClientCapabilities;
    clientInfo?: { name: string; version: string };
  }): Promise<InitializeResult> {
    if (!this.sdkConn) throw new TransportError("Not connected");
    return (await this.sdkConn.initialize(params)) as InitializeResult;
  }

  async authenticate(methodId: string, authMethod: any): Promise<void> {
    if (!this.sdkConn) throw new TransportError("Not connected");
    await this.sdkConn.authenticate({ methodId, authMethod });
  }

  async createSession(cwd: string, mcpServers: McpServerConfig[] = []): Promise<SessionRecord> {
    if (!this.sdkConn) throw new TransportError("Not connected");
    const resp = await this.sdkConn.newSession({ cwd, mcpServers });
    return { sessionId: resp.sessionId };
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: McpServerConfig[] = []
  ): Promise<SessionRecord> {
    if (!this.sdkConn) throw new TransportError("Not connected");
    await this.sdkConn.loadSession({ sessionId, cwd, mcpServers });
    return { sessionId };
  }

  async sendPrompt(sessionId: string, message: string): Promise<TurnController> {
    if (!this.sdkConn) throw new TransportError("Not connected");

    const promptPromise = this.sdkConn.prompt({
      sessionId,
      prompt: [{ type: "text", text: message }],
    });

    return new AcpTurnController(promptPromise, this.eventEmitter, sessionId, this.sdkConn);
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.sdkConn) throw new TransportError("Not connected");
    await this.sdkConn.cancel({ sessionId });
  }

  async *onEvent(signal?: AbortSignal): AsyncIterable<ConnectionEvent> {
    try {
      for await (const [event] of on(this.eventEmitter, "event", { signal })) {
        yield event as ConnectionEvent;
      }
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      throw err;
    }
  }
}

class AcpTurnController implements TurnController {
  constructor(
    public readonly result: Promise<any>,
    private eventEmitter: EventEmitter,
    private sessionId: string,
    private sdkConn: ClientSideConnection
  ) {}

  async cancel(): Promise<void> {
    await this.sdkConn.cancel({ sessionId: this.sessionId });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ConnectionEvent> {
    const ac = new AbortController();
    this.result.finally(() => ac.abort());

    try {
      const iterator = on(this.eventEmitter, "event", { signal: ac.signal });
      for await (const [event] of iterator) {
        const connEvent = event as ConnectionEvent;
        // Filter by session ID if possible (SessionNotification has sessionId)
        if (connEvent.payload?.sessionId && connEvent.payload.sessionId !== this.sessionId) {
          continue;
        }
        yield connEvent;
      }
    } catch (err: any) {
      if (err.name === "AbortError") return;
      throw err;
    }
  }
}
