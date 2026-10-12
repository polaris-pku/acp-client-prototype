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
  /** 解析结果连同来源。探针据此填 `provenance`，不靠比对命令字符串猜。 */
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
