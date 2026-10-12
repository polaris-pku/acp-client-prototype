import { AgentAdapter, LaunchCommand, LaunchProvenance } from "./interface.js";
import { ConnectionType } from "../connection/interface.js";
import { AuthStrategyType } from "../auth/interface.js";
import type { PtyOutputParser } from "../connection/pty-parser.js";
import { pinnedLaunch, resolveLocalLaunch, type LocalLaunchSpec } from "./local-launch.js";

export abstract class BaseAdapter implements AgentAdapter {
  /**
   * 本地已安装入口的解析说明。子类在构造末尾赋值。
   *
   * 能解析到包时用它绕开 npx；不设或解析失败则退回 `defaultCommand`。
   */
  protected localLaunch?: LocalLaunchSpec;

  constructor(
    public readonly agentId: string,
    public readonly name: string,
    public readonly description: string,
    public readonly connectionType: ConnectionType,
    protected readonly defaultCommand: string,
    protected readonly defaultArgs: string[],
    protected readonly authStrategy: AuthStrategyType = "none",
    public readonly authEnvMap: Record<string, string> = {}
  ) {}

  resolveCommand(): LaunchCommand {
    return this.resolveLaunch().launch;
  }

  /**
   * 解析结果连同它的来源。探针要把「这条命令哪来的」报给上层，靠比对命令字符串
   * 猜是不行的——`path` 与 `npx` 两条通道都可能给出绝对路径。
   */
  resolveLaunch(): { launch: LaunchCommand; provenance: LaunchProvenance } {
    const envCommand = process.env[`${this.agentId.toUpperCase()}_CLI_COMMAND`];
    const envArgs = process.env[`${this.agentId.toUpperCase()}_CLI_ARGS`];
    const fallback = {
      command: this.defaultCommand,
      args: envArgs ? envArgs.split(" ") : this.defaultArgs,
    };

    // 显式覆盖永远优先：离线评测等场景靠它指向预装入口。
    if (envCommand) {
      return { launch: { ...fallback, command: envCommand }, provenance: "env-override" };
    }

    // 探测已经实证过的入口优先于重新解析：建连与探测必须发同一条命令。
    const pinned = pinnedLaunch(this.agentId);
    if (pinned) return pinned;

    // 能就地解析到包就直接执行已安装入口，绕开 npx 每次约 1.4 秒的包解析开销。
    // 解析不到（未安装、安装位置异常）返回 undefined，退回改动前的 npx 行为。
    const local = this.localLaunch ? resolveLocalLaunch(this.localLaunch) : undefined;
    if (local) return { launch: local, provenance: "local-entry" };

    // 默认命令是 npx 的，说明本机没有它，只能靠 npx 按需拉起（首次要下载包）。
    // 这条和 path 不是一回事：`goose` 这种裸命令是用户真的装了。
    const provenance: LaunchProvenance =
      this.defaultCommand === "npx" || this.defaultCommand === "uvx" ? "npx-on-demand" : "path";

    return { launch: fallback, provenance };
  }

  resolveEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    // Automatically include mapped auth env vars
    for (const envVar of Object.keys(this.authEnvMap)) {
      if (process.env[envVar]) {
        env[envVar] = process.env[envVar];
      }
    }
    return env;
  }

  resolveAuthStrategy(): AuthStrategyType {
    return this.authStrategy;
  }

  normalizeResponse?(method: string, raw: unknown): unknown {
    return raw;
  }

  createPtyParser?(): PtyOutputParser | undefined {
    return undefined;
  }
}
