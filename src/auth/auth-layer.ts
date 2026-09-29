import { AuthExecutor, AuthStrategy, AuthCredential, AuthStrategyType } from "./interface.js";
import { NoneStrategy, PreConfiguredStrategy } from "./strategies/simple-strategies.js";
import { EnvAutoStrategy } from "./strategies/env-auto-strategy.js";
import { InteractiveStrategy } from "./strategies/interactive-strategy.js";
import { AutoStrategy } from "./strategies/auto-strategy.js";
import { AuthError } from "../core/errors.js";

export class AuthLayer implements AuthExecutor {
  private strategies = new Map<AuthStrategyType, AuthStrategy>();

  constructor() {
    this.strategies.set("none", new NoneStrategy());
    this.strategies.set("pre-configured", new PreConfiguredStrategy());
    this.strategies.set("env-auto", new EnvAutoStrategy());
    this.strategies.set("interactive", new InteractiveStrategy());
    this.strategies.set("auto", new AutoStrategy());
  }

  async execute(
    strategyType: AuthStrategyType,
    authMethods: any[],
    verbose?: boolean
  ): Promise<AuthCredential | null> {
    const strategy = this.strategies.get(strategyType);
    if (!strategy) {
      throw new AuthError(`Unknown auth strategy: ${strategyType}`);
    }

    return await strategy.execute(authMethods, verbose);
  }
}
