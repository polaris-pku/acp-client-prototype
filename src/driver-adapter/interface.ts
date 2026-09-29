import { ConnectionType } from "../connection/interface.js";
import { AuthStrategyType } from "../auth/interface.js";
import type { PtyOutputParser } from "../connection/pty-parser.js";

export interface AgentAdapter {
  readonly agentId: string;
  readonly name: string;
  readonly description: string;
  readonly connectionType: ConnectionType;

  resolveCommand(): { command: string; args: string[] };
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
