import { ConnectionType } from "../connection/interface.js";
import { AuthStrategyType } from "../auth/interface.js";
import type { PtyOutputParser } from "../connection/pty-parser.js";

/** adapter 解析出的可执行入口。 */
export interface LaunchCommand {
  command: string;
  args: string[];
}

/** 入口来自哪条通道。探针把它作为探测结果的一部分报给上层。 */
export type LaunchProvenance = "env-override" | "local-entry" | "path" | "npx-on-demand";

export interface AgentAdapter {
  readonly agentId: string;
  readonly name: string;
  readonly description: string;
  readonly connectionType: ConnectionType;

  resolveCommand(): LaunchCommand;
  /**
   * 解析结果连同来源。探针据此填 `provenance`，不靠比对命令字符串猜。
   *
   * @remarks
   * 基类的兜底分支把「三条通道都没命中」判成 `path`，前提是默认命令为 PATH 上的
   * 可执行名。默认命令是启动器加脚本路径的（如 `node dist/.../mock-driver.js`），
   * 必须自行实现本方法声明来源，否则会被静默报成 `path`。
   */
  resolveLaunch(): { launch: LaunchCommand; provenance: LaunchProvenance };
  resolveEnv(): Record<string, string | undefined>;
  resolveAuthStrategy(): AuthStrategyType;

  // ACP specific quirks
  beforeSpawn?(): Promise<void>;
  normalizeResponse?(method: string, raw: unknown): unknown;

  /** Mapping of Environment Variables to Auth Method IDs */
  authEnvMap?: Record<string, string>;

  // PTY specific
  createPtyParser?(): PtyOutputParser | undefined;
}
