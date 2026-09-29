export type AuthStrategyType = "none" | "env-auto" | "pre-configured" | "interactive" | "auto";

export interface AuthCredential {
  methodId: string;
  token?: string;
  [key: string]: any;
}

export interface AuthStrategy {
  readonly type: AuthStrategyType;
  execute(authMethods: any[], verbose?: boolean): Promise<AuthCredential | null>;
}

export interface AuthExecutor {
  execute(
    strategyType: AuthStrategyType,
    authMethods: any[],
    verbose?: boolean
  ): Promise<AuthCredential | null>;
}
