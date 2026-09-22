import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * 一个 adapter 的「本地已安装入口」说明。
 *
 * adapter 默认走 `npx -y <pkg>` 拉起 agent，而那意味着每个 turn 都要付一次 npx 的
 * 包解析开销——实测约 1.4 秒，占冷启动的 59%。能就地解析到包时，直接执行已安装入口
 * 可以把这段开销整个绕开。
 */
export interface LocalLaunchSpec {
  /** npm 包名，用于从本包的位置解析依赖。 */
  packageName: string;
  /** 包的 bin 名；包只声明一个 bin 时可省略。声明多个时必须给出，否则放弃解析。 */
  binName?: string;
  /** 传给入口的参数（不含入口自身）。 */
  args: readonly string[];
}

export interface ResolvedLaunch {
  command: string;
  args: string[];
}

const requireFromHere = createRequire(import.meta.url);

/**
 * 解析结果按 spec 缓存：解析是同步 IO，而 `resolveCommand()` 每次建连都会被调用。
 * `null` 也表示一种结果（「确认解析不到」），与「还没算过」区分开。
 */
const cache = new Map<string, ResolvedLaunch | null>();

/**
 * 把 spec 解析成可直接 spawn 的 `{ command, args }`。
 *
 * 任何一步不成立都返回 `undefined`（调用方据此退回 npx），**不抛异常**：
 * 这个方法处在建连路径上，包没装或装法异常都不该让 adapter 起不来。
 */
export function resolveLocalLaunch(spec: LocalLaunchSpec): ResolvedLaunch | undefined {
  const key = `${spec.packageName}\u0000${spec.binName ?? ""}\u0000${spec.args.join("\u0000")}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached ?? undefined;

  const resolved = computeLocalLaunch(spec);
  cache.set(key, resolved ?? null);
  return resolved;
}

function computeLocalLaunch(spec: LocalLaunchSpec): ResolvedLaunch | undefined {
  const packageJsonPath = resolvePackageJson(spec.packageName);
  if (!packageJsonPath) return undefined;

  const entry = resolveEntry(packageJsonPath, spec);
  if (!entry) return undefined;

  // JS 与带 shebang 的脚本要用 node 跑（Windows 上没有 shebang 支持，必须显式指定）；
  // 原生二进制（如 opencode 的 .exe）则必须直接执行。
  return needsNode(entry)
    ? { command: process.execPath, args: [entry, ...spec.args] }
    : { command: entry, args: [...spec.args] };
}

function resolvePackageJson(packageName: string): string | undefined {
  try {
    return requireFromHere.resolve(`${packageName}/package.json`);
  } catch {
    verbose(`${packageName} 无法从本包解析，回退 npx`);
    return undefined;
  }
}

function resolveEntry(packageJsonPath: string, spec: LocalLaunchSpec): string | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    return undefined;
  }

  const bin = (manifest as { bin?: unknown } | null)?.bin;
  let relative: string | undefined;
  if (typeof bin === "string") {
    relative = bin;
  } else if (bin && typeof bin === "object") {
    const entries = bin as Record<string, unknown>;
    const names = Object.keys(entries);
    // 只声明一个 bin 时无从选错；声明多个时必须由 adapter 指名，不猜键序。
    const chosen = spec.binName ?? (names.length === 1 ? names[0] : undefined);
    const value = chosen ? entries[chosen] : undefined;
    relative = typeof value === "string" ? value : undefined;
  }

  if (!relative) {
    verbose(`${spec.packageName} 未声明可用的 bin 入口，回退 npx`);
    return undefined;
  }

  const absolute = path.resolve(path.dirname(packageJsonPath), relative);
  // 声明的入口未必真的落地：平台二进制靠 optionalDependencies 提供、或安装时
  // 跳过了构建脚本（--ignore-scripts）都会留下空路径。不查存在性的话，回退到
  // npx 的保护就形同虚设——会 spawn 一个不存在的文件，报一个难查的 ENOENT。
  if (!existsSync(absolute)) {
    verbose(`${spec.packageName} 声明的入口不存在（${relative}），回退 npx`);
    return undefined;
  }
  return absolute;
}

/**
 * 入口是否需要用 node 执行。
 *
 * 先看扩展名，再看 shebang——只查其中一项会漏：codebuddy 的 `bin/codebuddy` 没有
 * 扩展名，但确实是 `#!/usr/bin/env node` 脚本。
 */
function needsNode(entryPath: string): boolean {
  if (/\.(c|m)?js$/i.test(entryPath)) return true;
  return startsWithShebang(entryPath);
}

function startsWithShebang(entryPath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(entryPath, "r");
    const head = Buffer.alloc(2);
    // 只读头两个字节：gemini 的入口是几 MB 的 bundle，整份读进来没有意义。
    if (readSync(fd, head, 0, 2, 0) !== 2) return false;
    return head[0] === 0x23 && head[1] === 0x21; // "#!"
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 回退到 npx 是静默的降级，VERBOSE 下说明原因，否则「为什么这个 agent 慢」无从查起。 */
function verbose(message: string): void {
  if (process.env.VERBOSE === "1") {
    process.stderr.write(`[adapter] ${message}\n`);
  }
}
