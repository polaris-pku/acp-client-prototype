import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { ADAPTER_REGISTRY } from "./registry.js";
import { AcpConnection } from "../connection/acp-connection.js";
import { clearPinnedLaunch, clearResolvedLaunchCache, pinResolvedLaunch } from "./local-launch.js";
import type { AgentAdapter, LaunchCommand, LaunchProvenance } from "./interface.js";

export type AgentId = string;

export type Provenance = LaunchProvenance;
export type ResolvedLaunch = LaunchCommand;

export interface InitializeEvidence {
  protocolVersion: number;
  authMethods: number;
  agentCapabilities?: string[];
  agentVersion?: string;
}

export interface AgentProbe {
  agentId: AgentId;
  displayName: string;
  launch: ResolvedLaunch;
  provenance: Provenance;
  connectionType: "acp" | "pty";
  initialize?: InitializeEvidence;
  probedAt: string;
}

export interface ProbeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  force?: boolean;
}

export interface ProbeAllOptions extends ProbeOptions {
  concurrency?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CONCURRENCY = 3;
const CACHE_TTL_MS = 10 * 60 * 1000;
/** 失败结论用更短 TTL：用户刚装完 agent 时不该等满 10 分钟才看得到。 */
const FAILURE_TTL_MS = 60 * 1000;
/** pty 的观察窗口：进程活过这段时间即视为可用。 */
const PTY_SETTLE_MS = 1200;

/**
 * 不参与探测的 adapter：mock 驱动跑在进程内，没有可 spawn 的命令，
 * 「本机是否装了它」这个问题对它不成立。
 */
const NOT_PROBEABLE = new Set(["mock-driver"]);

interface CacheEntry {
  probe: AgentProbe | null;
  at: number;
}

const cache = new Map<AgentId, CacheEntry>();
/** 同一时刻并发探测同一个 agent 时，后来者等这一份，避免重复拉起进程。 */
const inFlight = new Map<AgentId, Promise<AgentProbe | null>>();

export async function probeAgent(
  agentId: AgentId,
  opts: ProbeOptions = {}
): Promise<AgentProbe | null> {
  const adapter = ADAPTER_REGISTRY.getAdapter(agentId);
  if (!adapter) {
    throw new Error(`Unknown agentId: ${agentId}`);
  }
  if (NOT_PROBEABLE.has(agentId)) return null;

  if (opts.signal?.aborted) return null;
  if (!opts.force) {
    const cached = readCache(agentId);
    if (cached !== undefined) return cached;
  }

  const running = inFlight.get(agentId);
  if (running) return running;

  const task = (async () => {
    try {
      return await runProbe(adapter, opts);
    } finally {
      inFlight.delete(agentId);
    }
  })();

  inFlight.set(agentId, task);
  return task;
}

export async function probeAgents(opts: ProbeAllOptions = {}): Promise<AgentProbe[]> {
  const candidates = ADAPTER_REGISTRY.listAdapters().filter(
    (adapter) => !NOT_PROBEABLE.has(adapter.agentId)
  );

  // 结果按注册表顺序返回，与并发度无关
  const slots = await mapWithConcurrency(
    candidates,
    opts.concurrency ?? DEFAULT_CONCURRENCY,
    (candidate) => probeAgent(candidate.agentId, opts)
  );

  return slots.filter((probe): probe is AgentProbe => probe !== null);
}

export function invalidateProbe(id?: AgentId): void {
  if (id === undefined) cache.clear();
  else cache.delete(id);
  clearPinnedLaunch(id);
}

function store(agentId: AgentId, probe: AgentProbe | null): AgentProbe | null {
  cache.set(agentId, { probe, at: Date.now() });
  return probe;
}

async function runProbe(adapter: AgentAdapter, opts: ProbeOptions): Promise<AgentProbe | null> {
  if (opts.force) {
    // 强制重探就从头解析：钉住的上一条命令可能正是因为环境变了才失效的
    clearPinnedLaunch(adapter.agentId);
    clearResolvedLaunchCache();
  }

  const { launch, provenance } = adapter.resolveLaunch();

  let resolvedLaunch = launch;
  const resolvedProvenance = provenance;

  // path 通道存裸命令名，交给系统 PATH 解析；落到结果里换成绝对路径，
  // 让上层能显示、也让建连拿到确定的东西。
  if (provenance === "path") {
    const absolute = resolveOnPath(launch.command);
    if (!absolute) return store(adapter.agentId, null);
    resolvedLaunch = { command: absolute, args: launch.args };
  }

  // 在拉起进程之前钉住：探测与建连必须发同一条命令，探测失败时这条也一样适用
  pinResolvedLaunch(adapter.agentId, resolvedLaunch, resolvedProvenance);

  const probe =
    adapter.connectionType === "pty"
      ? await probePty(adapter, resolvedProvenance, resolvedLaunch, opts)
      : await probeAcp(adapter, resolvedProvenance, resolvedLaunch, opts);

  return store(adapter.agentId, probe);
}

function readCache(agentId: AgentId): AgentProbe | null | undefined {
  const entry = cache.get(agentId);
  if (!entry) return undefined;
  const ttl = entry.probe ? CACHE_TTL_MS : FAILURE_TTL_MS;
  if (Date.now() - entry.at > ttl) {
    cache.delete(agentId);
    return undefined;
  }
  return entry.probe;
}

async function probeAcp(
  adapter: AgentAdapter,
  provenance: Provenance,
  launch: ResolvedLaunch,
  opts: ProbeOptions
): Promise<AgentProbe | null> {
  const connection = new AcpConnection();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  let settled = false;

  /**
   * 超时与取消共用一条中断路径：先拆连接（Windows 下 disconnect 会 taskkill /T
   * 整棵进程树），再让 race 失败。所以取消后不会留下正在下载包的 npx 子进程。
   */
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      void connection.disconnect();
      reject(new Error("initialize-timeout"));
    }, timeoutMs);

    if (opts.signal) {
      onAbort = () => {
        if (settled) return;
        void connection.disconnect();
        reject(new Error("probe-aborted"));
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  try {
    const evidence = await Promise.race([
      (async (): Promise<InitializeEvidence> => {
        await connection.connect({
          ...launch,
          env: adapter.resolveEnv() as Record<string, string | undefined>,
        });
        const result = await connection.initialize({
          protocolVersion: 1,
          clientCapabilities: { fs: {}, terminal: false },
          clientInfo: { name: "acp-probe", version: "0.1.0" },
        });
        return {
          protocolVersion: result.protocolVersion,
          authMethods: result.authMethods?.length ?? 0,
          agentCapabilities: capabilityNames(result.agentCapabilities),
          agentVersion: result.agentInfo?.version,
        };
      })(),
      interrupted,
    ]);

    settled = true;
    return {
      agentId: adapter.agentId,
      displayName: adapter.name,
      launch,
      provenance,
      connectionType: "acp",
      initialize: evidence,
      probedAt: new Date().toISOString(),
    };
  } catch {
    settled = true;
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    await connection.disconnect().catch(() => undefined);
  }
}

/**
 * pty 类型没有握手，可用性由「进程能起来且不立即退出」证明：
 * 起不来或提前退出 → 不可用；活过观察窗口 → 可用。
 */
async function probePty(
  adapter: AgentAdapter,
  provenance: Provenance,
  launch: ResolvedLaunch,
  opts: ProbeOptions
): Promise<AgentProbe | null> {
  const settleMs = Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, PTY_SETTLE_MS);

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const child = spawn(launch.command, launch.args, {
    stdio: "ignore",
    env: { ...process.env, ...adapter.resolveEnv() },
  });

  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, settleMs);
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        reject(new Error(`exited early: code=${code} signal=${signal}`))
      );
      if (opts.signal) {
        // 取消与失败走同一条出口，finally 里统一杀进程树
        onAbort = () => reject(new Error("probe-aborted"));
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    return {
      agentId: adapter.agentId,
      displayName: adapter.name,
      launch,
      provenance,
      connectionType: "pty",
      probedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    child.removeAllListeners();
    killTree(child.pid);
  }
}

/**
 * 能力是 initialize 响应里的顶层键；`_meta` 是协议留的扩展元数据槽，
 * 不是能力标志位，混进列表上层会看不懂。
 */
function capabilityNames(capabilities: unknown): string[] | undefined {
  if (!capabilities || typeof capabilities !== "object") return undefined;
  const names = Object.keys(capabilities).filter((key) => !key.startsWith("_"));
  return names.length > 0 ? names.sort() : undefined;
}

/**
 * 用系统的 which/where 解析绝对路径。解析不到返回 undefined。
 *
 * 已经是绝对路径的（adapter 自己做过回退解析，比如 kiro 的 LOCALAPPDATA 分支）
 * 直接放行：`where` 收到绝对路径会直接报错退出。
 */
function resolveOnPath(command: string): string | undefined {
  if (path.isAbsolute(command)) return command;

  const locator = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(locator, [command], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return undefined;
  const first = result.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
  return first?.trim() || undefined;
}

/** Windows 上只 kill 到包装进程杀不掉子进程树，npx / npm shim 都需要整树终止。 */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)]);
      return;
    } catch {
      // 落到单进程 kill
    }
  }
  try {
    process.kill(pid);
  } catch {
    // 已经退出了
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}
