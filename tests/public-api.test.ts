import test from "node:test";
import assert from "node:assert/strict";
import {
  AcpClientBuilder,
  AcpConnection,
  AuthLayer,
  ClientMethodRouter,
  DefaultPtyParser,
  MemorySessionStore,
  TerminalHandler,
  type AgentAdapter,
  type AgentConnection,
  type AuthExecutor,
  type ClientCapabilities,
  type ClientMethodHandler,
  type ConnectionEvent,
  type ConnectionFactory,
  type McpServerConfig,
  type PtyOutputParser,
  type SessionManager,
  type TerminalHandlerOptions,
  type TurnController,
} from "../src/index.js";

class PublicHandler implements ClientMethodHandler {
  async handle(method: string, params: unknown): Promise<unknown> {
    return { method, params };
  }
}

class PublicAuthExecutor implements AuthExecutor {
  async execute(): Promise<null> {
    return null;
  }
}

test("public root exports support upper-layer extension wiring", () => {
  const methodRouter = new ClientMethodRouter();
  methodRouter.register("custom", new PublicHandler());

  const authLayer = new AuthLayer();
  const customAuthLayer = new PublicAuthExecutor();
  const sessionManager: SessionManager = new MemorySessionStore();
  const parser: PtyOutputParser = new DefaultPtyParser();
  const connection: AgentConnection = new AcpConnection();
  const terminalOptions: TerminalHandlerOptions = { defaultOutputByteLimit: 4096 };
  const terminal = new TerminalHandler(terminalOptions);
  const connectionFactory: ConnectionFactory = (_adapter: AgentAdapter) => connection;
  const capabilities: ClientCapabilities = { terminal: true };
  const mcpServers: McpServerConfig[] = [];
  const events: ConnectionEvent[] = [];
  const maybeTurn: TurnController | null = null;

  const client = new AcpClientBuilder()
    .withAgent("mock-driver")
    .withMethodRouter(methodRouter)
    .withAuthLayer(customAuthLayer)
    .withSessionManager(sessionManager)
    .withConnectionFactory(connectionFactory)
    .withTerminalHandler(terminal)
    .build();

  assert.equal(typeof authLayer.execute, "function");
  assert.equal(parser.id, "default");
  assert.equal(typeof client.initialize, "function");
  assert.equal(capabilities.terminal, true);
  assert.equal(mcpServers.length, 0);
  assert.equal(events.length, 0);
  assert.equal(maybeTurn, null);
});
