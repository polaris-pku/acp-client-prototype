import { ClientMethodHandler } from "./interface.js";
import spawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { WorkspaceBoundary } from "../security/workspace-boundary.js";
import { processSandboxEnabled, wrapSpawnForProcessSandbox } from "../security/eval-fs-jail.js";
import { internalError, invalidParams, methodNotFound, resourceNotFound } from "./error-utils.js";

// ── Terminal env isolation (whitelist-only, no API keys) ──

const TERMINAL_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "USER",
  "LOGNAME",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
] as const;

export function createTerminalEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of TERMINAL_ENV_KEYS) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith("LC_") && value !== undefined) result[key] = value;
  }
  return result;
}
// ── Internal types ──

interface TerminalExitStatus {
  exitCode?: number | null;
  signal?: string | null;
}

interface TerminalRecord {
  id: string;
  process: ChildProcess;
  output: string;
  outputBytes: number;
  outputByteLimit: number;
  truncated: boolean;
  exitStatus?: TerminalExitStatus;
  exitPromise: Promise<TerminalExitStatus>;
  resolveExit: (status: TerminalExitStatus) => void;
  released: boolean;
}

export interface TerminalHandlerOptions {
  defaultOutputByteLimit?: number;
  /** Workspace root directory for path boundary enforcement. Defaults to process.cwd(). */
  workspace?: string;
}

const DEFAULT_OUTPUT_BYTE_LIMIT = 1024 * 1024;

// ── Handler ──

export class TerminalHandler implements ClientMethodHandler {
  private terminals = new Map<string, TerminalRecord>();
  private nextId = 1;
  private readonly boundary: WorkspaceBoundary;
  private defaultOutputByteLimit: number;

  constructor(options: TerminalHandlerOptions | string = {}) {
    const normalized = typeof options === "string" ? { workspace: options } : options;
    this.boundary = new WorkspaceBoundary(normalized.workspace ?? process.cwd());
    this.defaultOutputByteLimit = normalized.defaultOutputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT;
  }

  async handle(method: string, params: any): Promise<any> {
    switch (method) {
      case "terminal/create":
        return await this.create(params);
      case "terminal/output":
        return this.output(params);
      case "terminal/wait_for_exit":
        return this.waitForExit(params);
      case "terminal/kill":
        return this.kill(params);
      case "terminal/release":
        return this.release(params);
      default:
        throw methodNotFound(method);
    }
  }

  private async create(params: any): Promise<{ terminalId: string }> {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw invalidParams("terminal/create requires object params", { params });
    }
    if (typeof params.command !== "string" || params.command.length === 0) {
      throw invalidParams("terminal/create requires a non-empty command", {
        command: params.command,
      });
    }
    if (params.args !== undefined && !Array.isArray(params.args)) {
      throw invalidParams("terminal/create args must be an array", { args: params.args });
    }
    if (params.cwd !== undefined && typeof params.cwd !== "string") {
      throw invalidParams("terminal/create cwd must be a string", { cwd: params.cwd });
    }

    const id = `term_${this.nextId++}`;
    const outputByteLimit = this.normalizeOutputByteLimit(params.outputByteLimit);
    const userEnv = this.normalizeEnv(params.env);

    // Resolve and validate cwd against workspace boundary
    const requestedCwd = params.cwd ?? ".";
    const cwd = await this.boundary.resolveExisting(requestedCwd);

    let resolveExit!: (status: TerminalExitStatus) => void;
    const exitPromise = new Promise<TerminalExitStatus>((resolve) => {
      resolveExit = resolve;
    });

    const args = params.args ?? [];
    const baseEnv = { ...createTerminalEnv(process.env), PWD: cwd };
    const mergedEnv = { ...baseEnv, ...userEnv };
    let proc: ChildProcess;
    if (processSandboxEnabled()) {
      const jailed = wrapSpawnForProcessSandbox({
        command: params.command,
        args,
        cwd,
        jailRoot: this.boundary.root,
        env: mergedEnv,
        shellCommand: args.length === 0 && this.shouldUseShell(params.command),
      });
      proc = spawn(jailed.command, jailed.args, {
        shell: false,
        cwd: jailed.cwd,
        env: { ...mergedEnv, ...jailed.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } else {
      proc = spawn(params.command, args, {
        shell: args.length === 0 && this.shouldUseShell(params.command),
        cwd,
        env: mergedEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    }

    const record: TerminalRecord = {
      id,
      process: proc,
      output: "",
      outputBytes: 0,
      outputByteLimit,
      truncated: false,
      exitPromise,
      resolveExit,
      released: false,
    };

    const appendOutput = (chunk: Buffer | string) => {
      this.appendOutput(record, chunk);
    };

    proc.stdout?.on("data", appendOutput);
    proc.stderr?.on("data", appendOutput);
    proc.once("exit", (code, signal) => {
      const status = { exitCode: code, signal };
      record.exitStatus = status;
      record.resolveExit(status);
    });
    proc.once("error", (err) => {
      this.appendOutput(record, `\n[terminal error] ${err.message}\n`);
      const status = { exitCode: null, signal: "error" };
      record.exitStatus = status;
      record.resolveExit(status);
    });

    this.terminals.set(id, record);
    return { terminalId: id };
  }

  private output(params: any) {
    const record = this.getTerminal(params.terminalId);
    return {
      output: record.output,
      truncated: record.truncated,
      ...(record.exitStatus ? { exitStatus: record.exitStatus } : {}),
    };
  }

  private async waitForExit(params: any): Promise<TerminalExitStatus> {
    const record = this.getTerminal(params.terminalId);
    const status = record.exitStatus ?? (await record.exitPromise);
    return {
      exitCode: status.exitCode ?? null,
      signal: status.signal ?? null,
    };
  }

  private async kill(params: any): Promise<Record<string, never>> {
    const record = this.getTerminal(params.terminalId);
    await this.killProcess(record);
    return {};
  }

  private async release(params: any): Promise<Record<string, never>> {
    const record = this.getTerminal(params.terminalId);
    record.released = true;
    await this.killProcess(record);
    this.destroyStreams(record.process);
    this.terminals.delete(record.id);
    return {};
  }

  private getTerminal(terminalId: string): TerminalRecord {
    if (typeof terminalId !== "string" || terminalId.length === 0) {
      throw invalidParams("terminalId must be a non-empty string", { terminalId });
    }

    const record = this.terminals.get(terminalId);
    if (!record || record.released) {
      throw resourceNotFound(terminalId);
    }
    return record;
  }

  private appendOutput(record: TerminalRecord, chunk: Buffer | string): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const bytes = Buffer.byteLength(text, "utf8");
    record.output += text;
    record.outputBytes += bytes;

    if (record.outputBytes > record.outputByteLimit) {
      record.truncated = true;
      while (record.outputBytes > record.outputByteLimit && record.output.length > 0) {
        const firstCodePoint = Array.from(record.output)[0] ?? "";
        record.output = record.output.slice(firstCodePoint.length);
        record.outputBytes -= Buffer.byteLength(firstCodePoint, "utf8");
      }
    }
  }

  private async killProcess(record: TerminalRecord): Promise<void> {
    if (record.exitStatus) return;

    const pid = record.process.pid;
    if (process.platform === "win32" && pid) {
      const killed = await new Promise<boolean>((resolve) => {
        try {
          const killer = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.once("exit", (code) => resolve(code === 0));
          killer.once("error", () => resolve(false));
        } catch {
          resolve(false);
        }
      });

      if (killed || record.exitStatus) {
        return;
      }

      try {
        record.process.kill();
        return;
      } catch {
        throw internalError(`Failed to kill terminal process ${record.id}`, {
          terminalId: record.id,
          pid,
        });
      }
    }

    try {
      record.process.kill();
    } catch (err) {
      throw internalError(`Failed to kill terminal process ${record.id}`, {
        terminalId: record.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private destroyStreams(proc: ChildProcess): void {
    try {
      proc.stdin?.destroy();
      proc.stdout?.destroy();
      proc.stderr?.destroy();
    } catch {
      // ignore cleanup errors
    }
  }

  private normalizeOutputByteLimit(value: unknown): number {
    if (value === undefined) {
      return this.defaultOutputByteLimit;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw invalidParams("outputByteLimit must be a positive finite number", {
        outputByteLimit: value,
      });
    }
    return Math.floor(value);
  }

  private normalizeEnv(value: unknown): Record<string, string> {
    if (value === undefined) return {};
    if (!Array.isArray(value)) {
      throw invalidParams("terminal env must be an array of name/value pairs", { env: value });
    }

    return Object.fromEntries(
      value
        .map((item) => {
          if (!item || typeof item.name !== "string" || typeof item.value !== "string") {
            throw invalidParams("terminal env entries must include string name and value", {
              entry: item,
            });
          }
          return item;
        })
        .map((item) => [item.name, item.value])
    );
  }

  private shouldUseShell(command: unknown): boolean {
    if (typeof command !== "string") return false;
    return /[<>|&;]/.test(command);
  }
}
