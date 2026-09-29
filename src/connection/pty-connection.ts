import * as pty from "node-pty";
import { spawnSync } from "node:child_process";
import { EventEmitter, on } from "node:events";
import path from "node:path";
import {
  AgentConnection,
  ConnectionOptions,
  ConnectionEvent,
  InitializeResult,
  SessionRecord,
  TurnController,
} from "./interface.js";
import { PtyError } from "../core/errors.js";
import type { ClientCapabilities, McpServerConfig } from "../core/types.js";
import type {
  PtyOutputParser,
  PtyParserContext,
  PtyParserResult,
  PtyTurnResult,
} from "./pty-parser.js";
import { DefaultPtyParser } from "./pty-parsers/default-parser.js";

interface ActivePtyTurn {
  readonly sessionId: string;
  readonly context: PtyParserContext;
  completed: boolean;
  resolve(result: PtyTurnResult): void;
  reject(error: unknown): void;
}

export class PtyConnection implements AgentConnection {
  readonly type = "pty";
  private ptyProcess: pty.IPty | null = null;
  private eventEmitter = new EventEmitter();
  private readonly parser: PtyOutputParser;
  private verbose = false;
  private cwd = process.cwd();
  private sessionId = "pty_session";
  private activeTurn: ActivePtyTurn | null = null;

  constructor(parser?: PtyOutputParser) {
    this.parser = parser ?? new DefaultPtyParser();
  }

  get isConnected(): boolean {
    return !!this.ptyProcess;
  }

  setMethodRouter(_router: { route(method: string, params: any): Promise<any> }): void {
    // PTY doesn't support structured client methods yet
  }

  async connect(options: ConnectionOptions): Promise<void> {
    this.verbose = options.verbose ?? false;
    this.cwd = options.cwd || process.cwd();
    const command = resolvePtyCommand(options.command);
    this.ptyProcess = pty.spawn(command, options.args, {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: this.cwd,
      env: { ...process.env, ...options.env } as any,
    });

    this.ptyProcess.onData((data) => {
      if (this.verbose) {
        console.log(`\x1b[32m[PTY Output]\x1b[0m ${data}`);
      }
      const context = this.currentContext();
      this.handleParserResult(context, this.parser.onData(context, "stdout", data));
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      const context = this.currentContext();
      const parserResult = this.parser.onExit?.(context, exitCode, signal);
      if (parserResult) {
        this.handleParserResult(context, parserResult);
      } else {
        this.completeActiveTurn({
          stopReason: exitCode === 0 ? "end_turn" : "error",
          exitCode,
          signal,
          error: exitCode === 0 ? undefined : `PTY process exited with code ${exitCode}`,
        });
      }
      this.emitEvent("disconnect", { code: exitCode, signal });
      this.ptyProcess = null;
    });
  }

  private emitEvent(type: ConnectionEvent["type"], payload: any) {
    const event: ConnectionEvent = { type, payload };
    this.eventEmitter.emit("event", event);
  }

  async disconnect(): Promise<void> {
    if (this.ptyProcess) {
      this.completeActiveTurn({ stopReason: "cancelled" });
      this.ptyProcess.kill();
      this.ptyProcess = null;
    }
  }

  async initialize(_params: {
    protocolVersion: number;
    clientCapabilities: ClientCapabilities;
    clientInfo?: { name: string; version: string };
  }): Promise<InitializeResult> {
    return {
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: "PTY Agent", version: "1.0.0" },
    };
  }

  async authenticate(_methodId: string, _authMethod: any): Promise<void> {
    // PTY typically uses env vars for auth
  }

  async createSession(cwd: string, _mcpServers?: McpServerConfig[]): Promise<SessionRecord> {
    this.cwd = cwd;
    return { sessionId: this.sessionId };
  }

  async loadSession(
    _sessionId: string,
    _cwd: string,
    _mcpServers?: McpServerConfig[]
  ): Promise<SessionRecord> {
    throw new PtyError("PTY connections do not support session/load");
  }

  async sendPrompt(sessionId: string, message: string): Promise<TurnController> {
    if (!this.ptyProcess) throw new PtyError("Not connected");
    if (this.activeTurn && !this.activeTurn.completed) {
      throw new PtyError("A PTY turn is already in progress");
    }

    this.sessionId = sessionId;
    const context = this.currentContext();
    let resolveTurn!: (result: PtyTurnResult) => void;
    let rejectTurn!: (error: unknown) => void;
    const resultPromise = new Promise<PtyTurnResult>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    this.activeTurn = {
      sessionId,
      context,
      completed: false,
      resolve: resolveTurn,
      reject: rejectTurn,
    };

    const turnStartEvents = this.parser.onTurnStart?.(context, message) ?? [];
    for (const event of turnStartEvents) {
      this.eventEmitter.emit("event", event);
    }

    if (this.verbose) {
      console.log(`\x1b[34m[PTY Input]\x1b[0m ${message}`);
    }
    this.ptyProcess.write(message + "\r");

    return new PtyTurnController(resultPromise, this.eventEmitter, this);
  }

  async cancel(_sessionId: string): Promise<void> {
    if (this.verbose) {
      console.log(`\x1b[34m[PTY Input]\x1b[0m ^C`);
    }
    this.ptyProcess?.write("\x03");
    const context = this.currentContext();
    const parserResult = this.parser.onCancel?.(context);
    if (parserResult) {
      this.handleParserResult(context, parserResult);
    } else {
      this.completeActiveTurn({ stopReason: "cancelled" });
    }
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

  private currentContext(): PtyParserContext {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
    };
  }

  private handleParserResult(context: PtyParserContext, result: PtyParserResult): void {
    for (const event of result.events ?? []) {
      this.eventEmitter.emit("event", event);
    }

    if (result.done) {
      this.completeActiveTurn(
        result.result ?? {
          stopReason: "end_turn",
        },
        context.sessionId
      );
    }
  }

  private completeActiveTurn(result: PtyTurnResult, sessionId = this.sessionId): void {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.completed || activeTurn.sessionId !== sessionId) {
      return;
    }

    activeTurn.completed = true;
    if (result.stopReason === "error") {
      activeTurn.reject(new PtyError(result.error ?? "PTY turn failed"));
    } else {
      activeTurn.resolve(result);
    }
    this.activeTurn = null;
  }
}

function resolvePtyCommand(command: string): string {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return command;
  }

  const lookupCommand = process.platform === "win32" ? "where.exe" : "which";
  const lookup = spawnSync(lookupCommand, [command], {
    encoding: "utf8",
    windowsHide: true,
  });

  if (lookup.status !== 0 || !lookup.stdout.trim()) {
    return command;
  }

  const firstMatch = lookup.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return firstMatch ?? command;
}

class PtyTurnController implements TurnController {
  constructor(
    public readonly result: Promise<any>,
    private eventEmitter: EventEmitter,
    private connection: PtyConnection
  ) {}

  async cancel(): Promise<void> {
    await this.connection.cancel("pty_session");
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ConnectionEvent> {
    const abortController = new AbortController();
    this.result.finally(() => abortController.abort()).catch(() => abortController.abort());

    try {
      for await (const [event] of on(this.eventEmitter, "event", {
        signal: abortController.signal,
      })) {
        yield event as ConnectionEvent;
      }
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      throw err;
    }
  }
}
