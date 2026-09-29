import { AcpClient, AcpClientOptions } from "./acp-client.js";
import { ADAPTER_REGISTRY } from "../driver-adapter/registry.js";
import { AcpConnection } from "../connection/acp-connection.js";
import { PtyConnection } from "../connection/pty-connection.js";
import { AgentConnection } from "../connection/interface.js";
import { AuthLayer } from "../auth/auth-layer.js";
import { AuthExecutor } from "../auth/interface.js";
import { MemorySessionStore } from "../session/memory-session-store.js";
import { SessionManager } from "../session/interface.js";
import { ClientMethodRouter } from "../client-methods/router.js";
import { ClientInterceptors } from "../hook-gate/interface.js";
import { FileSystemHandler } from "../client-methods/filesystem-handler.js";
import { PermissionHandler } from "../client-methods/permission-handler.js";
import { TerminalHandler } from "../client-methods/terminal-handler.js";
import { ClientMethodHandler } from "../client-methods/interface.js";
import { ExtensionMethod, loadExtensionConfig } from "../client-methods/extension-loader.js";
import { AgentAdapter } from "../driver-adapter/interface.js";
import { ConfigurationError } from "../core/errors.js";

export type ConnectionFactory = (adapter: AgentAdapter) => AgentConnection;

export class AcpClientBuilder {
  private agentId?: string;
  private verbose: boolean = false;
  private extensionConfigPath?: string;
  private handlers: Record<string, ClientMethodHandler> = {};
  private fileSystemHandler?: ClientMethodHandler;
  private permissionHandler?: ClientMethodHandler;
  private terminalHandler?: ClientMethodHandler;
  private methodRouter?: ClientMethodRouter;
  private authLayer?: AuthExecutor;
  private sessionManager?: SessionManager;
  private connection?: AgentConnection;
  private connectionFactory?: ConnectionFactory;
  private autoApprove: boolean = false;
  private sandboxDir: string = process.cwd();
  private interceptors?: ClientInterceptors;

  withAgent(agentId: string): this {
    this.agentId = agentId;
    return this;
  }

  withVerbose(verbose: boolean): this {
    this.verbose = verbose;
    return this;
  }

  withAutoApprove(autoApprove: boolean): this {
    this.autoApprove = autoApprove;
    return this;
  }

  withSandboxDir(sandboxDir: string): this {
    this.sandboxDir = sandboxDir;
    return this;
  }

  withExtensionConfig(configPath: string): this {
    this.extensionConfigPath = configPath;
    return this;
  }

  registerExtensionHandler(methodName: string, handler: ClientMethodHandler): this {
    this.handlers[methodName] = handler;
    return this;
  }

  registerMethodHandler(methodNameOrPrefix: string, handler: ClientMethodHandler): this {
    this.handlers[methodNameOrPrefix] = handler;
    return this;
  }

  withFileSystemHandler(handler: ClientMethodHandler): this {
    this.fileSystemHandler = handler;
    return this;
  }

  withPermissionHandler(handler: ClientMethodHandler): this {
    this.permissionHandler = handler;
    return this;
  }

  withTerminalHandler(handler: ClientMethodHandler): this {
    this.terminalHandler = handler;
    return this;
  }

  withMethodRouter(methodRouter: ClientMethodRouter): this {
    this.methodRouter = methodRouter;
    return this;
  }

  withAuthLayer(authLayer: AuthExecutor): this {
    this.authLayer = authLayer;
    return this;
  }

  withSessionManager(sessionManager: SessionManager): this {
    this.sessionManager = sessionManager;
    return this;
  }

  withConnection(connection: AgentConnection): this {
    this.connection = connection;
    return this;
  }

  withConnectionFactory(connectionFactory: ConnectionFactory): this {
    this.connectionFactory = connectionFactory;
    return this;
  }

  withInterceptors(interceptors: ClientInterceptors): this {
    this.interceptors = interceptors;
    return this;
  }

  build(): AcpClient {
    if (!this.agentId) {
      throw new ConfigurationError("Agent ID must be specified using 'withAgent()'");
    }

    const adapter = ADAPTER_REGISTRY.getAdapter(this.agentId);
    if (!adapter) {
      throw new ConfigurationError(`Unknown agent: ${this.agentId}`, { agentId: this.agentId });
    }

    const connection = this.resolveConnection(adapter);
    const authLayer = this.authLayer ?? new AuthLayer();
    const sessionManager = this.sessionManager ?? new MemorySessionStore();
    const methodRouter = this.methodRouter ?? new ClientMethodRouter();

    // Register default handlers
    methodRouter.register("fs", this.fileSystemHandler ?? new FileSystemHandler(this.sandboxDir));
    methodRouter.register(
      "session",
      this.permissionHandler ??
        new PermissionHandler(this.autoApprove || process.env.AUTO_APPROVE === "1")
    );
    methodRouter.register(
      "terminal",
      this.terminalHandler ?? new TerminalHandler({ workspace: this.sandboxDir })
    );

    // Register user defined handlers
    for (const [method, handler] of Object.entries(this.handlers)) {
      methodRouter.register(method, handler);
    }

    // Load extensions config if present
    const experimentalCapabilities: Record<string, any> = {};
    const extensionMethods: ExtensionMethod[] = [];
    if (this.extensionConfigPath) {
      try {
        const methods = loadExtensionConfig(this.extensionConfigPath);
        extensionMethods.push(...methods);
        for (const m of methods) {
          experimentalCapabilities[m.name] = {
            description: m.description,
            params: m.params || {},
          };
        }
      } catch (err) {
        if (this.verbose) {
          console.error(
            `[ClientBuilder] Failed to load extension config: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        throw err;
      }
    }

    const options: AcpClientOptions & { experimentalCapabilities?: Record<string, any> } = {
      adapter,
      connection,
      authLayer,
      sessionManager,
      methodRouter,
      interceptors: this.interceptors,
      verbose: this.verbose,
      experimentalCapabilities,
      sandboxDir: this.sandboxDir,
      extensionMethods,
    };

    return new AcpClient(options);
  }

  private resolveConnection(adapter: AgentAdapter): AgentConnection {
    if (this.connection && this.connectionFactory) {
      throw new ConfigurationError(
        "Use either withConnection() or withConnectionFactory(), not both"
      );
    }

    if (this.connection) {
      return this.connection;
    }

    if (this.connectionFactory) {
      return this.connectionFactory(adapter);
    }

    return adapter.connectionType === "acp"
      ? new AcpConnection()
      : new PtyConnection(adapter.createPtyParser?.());
  }
}
