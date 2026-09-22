# acp-client-prototype

[![EN](https://img.shields.io/badge/Language-English-blue.svg)](README.md)
[![ZH](https://img.shields.io/badge/Language-中文-red.svg)](README.zh.md)

# Universal ACP Client

A modular and extensible ACP (Agent Client Protocol) client library designed to connect standard AI coding agents (Gemini, Claude, Codex) and TUI-based tools (Aider) to upper-layer systems.

Powered by `@agentclientprotocol/sdk`.

---

## Key Capabilities & Features

- **Builder Pattern**: Instantiate and configure client instances via a clean, chainable Builder (`AcpClientBuilder`).
- **State Machine Integration**: Expose fine-grained state queries (`disconnected`, `initializing`, `authenticated`, `ready`, `busy`, `shutting_down`) and state change events.
- **Config-Driven Extensibility**: Define custom client capabilities in plain `YAML` or `JSON` and register extension method handlers effortlessly.
- **Isolated Test Layer**: Standardised Hello World testing is separated into its own package/layer to allow building the library and tests independently.

---

## Quick Start

### 0. Prerequisites

- Node.js `>=22.22.1`
- pnpm `>=11.8.0`

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure credentials

```bash
cp .env.example .env
# Edit .env with your API keys (e.g., GEMINI_API_KEY)
```

### 3. Run Separated Integration Test

```bash
pnpm hello gemini "Hello World"
```

---

## Architectural API & Interface Specifications

### 1. The Builder Pattern (`AcpClientBuilder`)

Instead of configuring child connections manually, use the `AcpClientBuilder` to set up and construct an `AcpClient`.

```typescript
import { AcpClientBuilder } from "acp-client-prototype";

const builder = new AcpClientBuilder()
  .withAgent("gemini") // Select agent adapter
  .withVerbose(true) // Enable verbose debug logging
  .withAutoApprove(true) // Auto-approve agent tool execution
  .withSandboxDir("/sandbox") // Enforce FileSystem sandboxing
  .withExtensionConfig("extensions.yaml") // Load custom client methods
  .registerExtensionHandler("custom/greet", new MyCustomHandler());

const client = builder.build();
```

#### Public API Surface

Upper-layer integrations should import extension contracts from the package root instead of
internal source paths:

```typescript
import {
  AcpClientBuilder,
  ClientMethodHandler,
  ClientMethodRouter,
  AgentConnection,
  AgentAdapter,
  AuthExecutor,
  SessionManager,
  PtyOutputParser,
  ClientCapabilities,
  McpServerConfig,
} from "acp-client-prototype";
```

The root export is organized around stable integration points:

| Category               | Public exports                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Client construction    | `AcpClientBuilder`, `AcpClient`, `AcpClientOptions`, `ConnectionFactory`                                     |
| Method handling        | `ClientMethodHandler`, `ClientMethodRouter`, `ExtensionMethod`, `loadExtensionConfig`                        |
| Default local handlers | `FileSystemHandler`, `PermissionHandler`, `TerminalHandler`, `TerminalHandlerOptions`                        |
| Connection extension   | `AgentConnection`, `ConnectionEvent`, `TurnController`, `AcpConnection`, `PtyConnection`                     |
| Adapter extension      | `AgentAdapter`, `ADAPTER_REGISTRY`                                                                           |
| Auth/session extension | `AuthExecutor`, `AuthLayer`, `SessionManager`, `MemorySessionStore`                                          |
| PTY parser extension   | `PtyOutputParser`, `PtyParserContext`, `DefaultPtyParser`, `AiderPtyParser`                                  |
| Protocol types         | `ClientCapabilities`, `McpServerConfig`, `SessionNotification`, `ToolCallUpdate`, and related ACP data types |

Implementation details such as the extension MCP server internals and private parser helpers are intentionally not part of the public root API.

#### Client Method Routing Policy

`AcpClientBuilder` always installs a `ClientMethodRouter` before the connection is used. If an
upper layer constructs an `AcpConnection` directly, it must call `setMethodRouter(...)` before
allowing an ACP agent to invoke client methods. Missing routers or missing handlers fail fast;
the connection does not return stub file, permission, terminal, or extension method results.

For production integration, the bundled handlers and stores are defaults only. Upper-layer
orchestrators can replace the method handlers, auth executor, session manager, or transport
connection during construction:

```typescript
import { AcpClientBuilder, ClientMethodRouter } from "acp-client-prototype";

const methodRouter = new ClientMethodRouter();
methodRouter.register("custom/audit", new AuditHandler());

const client = new AcpClientBuilder()
  .withAgent("gemini")
  .withFileSystemHandler(new CoordinatorFileSystemHandler())
  .withPermissionHandler(new CoordinatorPermissionHandler())
  .withTerminalHandler(new RemoteTerminalHandler())
  .withMethodRouter(methodRouter)
  .withAuthLayer(new CoordinatorAuthLayer())
  .withSessionManager(new PersistentSessionManager())
  .withConnectionFactory((adapter) => createObservedConnection(adapter))
  .build();
```

---

### 2. Client States & Events

The client exposes standard execution states and functions as a unified I/O channel for upper-layer orchestrators.

#### Connection & Turn States (`ClientState`)

The client transitions through the following states, queryable via `client.getState()`:

- `disconnected`: The child agent process has not been spawned.
- `initializing`: The process is spawned and waiting for initialize shake-hands.
- `authenticated`: The client has resolved and executed the appropriate credential strategy.
- `ready`: Active session created; the client is idle and ready for user prompt instructions.
- `busy`: Currently streaming thoughts, chunks, or executing tool calls on behalf of the remote Agent.
- `shutting_down`: Process termination and resource cleanups are in progress.

#### Type-Safe Event Reference

The `AcpClient` class extends Node's `EventEmitter` with typed overrides for `emit`, `on`, and `once`. Modern IDEs (like VS Code) will automatically provide autocomplete and type validation for these event names and payload objects.

Below is the complete registry of typed events emitted by the client:

| Event Name            | Parameter Type                                   | Description                                                                  |
| --------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `stateChange`         | `(newState: ClientState, oldState: ClientState)` | Triggered on any connection or execution state transition.                   |
| `event`               | `(event: ConnectionEvent)`                       | Raw, unmodified wrapper for any packet coming from the connection.           |
| `agent_message_chunk` | `(payload: any)`                                 | Live textual answer tokens streamed from the Agent.                          |
| `agentMessage`        | `(payload: any)`                                 | Compatibility alias emitted for `agent_message_chunk`.                       |
| `agent_thought_chunk` | `(payload: any)`                                 | Live thinking process tokens streamed from reasoning-capable Agents.         |
| `tool_call`           | `(payload: any)`                                 | Signals that the Agent wants to invoke a specific client/client method/tool. |
| `tool_call_update`    | `(payload: any)`                                 | Signals the execution result status of a requested tool call.                |
| `stderr`              | `(payload: any)`                                 | Raw standard error diagnostics emitted by the underlying Agent process.      |

Lifecycle hook events such as `pre:connect`, `post:initialize`, `pre:prompt`, and
`post:disconnect` are also emitted through the same `EventEmitter` interface.

```typescript
// Strict autocompleted subscription
client.on("stateChange", (newState, oldState) => {
  // TypeScript knows that newState and oldState are of type ClientState!
});
```

#### Connecting to Sub-Streams (I/O Outlet)

Upper layers can subscribe directly to specific stream events rather than parsing raw text:

```typescript
// Streamed text response chunks from the Agent
client.on("agent_message_chunk", (payload) => {
  process.stdout.write(payload.update.content.text);
});

// Streamed thinking/reasoning chunks from the Agent
client.on("agent_thought_chunk", (payload) => {
  console.log(`[Thinking] ${payload.update.content.text}`);
});

// Intercept tool calls
client.on("tool_call", (payload) => {
  console.log(`[Tool] Agent requested: ${payload.update.title}`);
});
```

---

### 3. Custom Method Capabilities (MCP Tool Bridge)

You can extend client capabilities without altering the core codebase. Define the custom method in a configuration file, register a handler, and the client exposes it to ACP agents as an MCP tool.

#### 1. Define Method Descriptions (`extensions.yaml`)

```yaml
methods:
  - name: "custom/greet"
    description: "Greet a user with a customized styling theme"
    params:
      name: "string"
      style: "string"
```

#### 2. Implement the Handler (`ClientMethodHandler`)

Write a custom class implementing `ClientMethodHandler`:

```typescript
import { ClientMethodHandler } from "acp-client-prototype";
import { RequestError } from "@agentclientprotocol/sdk";

class MyCustomHandler implements ClientMethodHandler {
  async handle(method: string, params: any): Promise<any> {
    if (method === "custom/greet") {
      return {
        greeting: `Hello ${params.name || "User"}, styled using: ${params.style || "plain"}`,
      };
    }
    throw RequestError.methodNotFound(method);
  }
}
```

For Agent-visible client methods and MCP tool calls, throw ACP SDK `RequestError`
instances when you need the Agent to see structured JSON-RPC `code`, `message`, and
`data`. Plain JavaScript errors are treated as internal failures by the protocol boundary.

#### 3. Register Custom Capabilities

```typescript
const builder = new AcpClientBuilder()
  .withAgent("gemini")
  .withExtensionConfig("extensions.yaml")
  .registerExtensionHandler("custom/greet", new MyCustomHandler());
```

When a session is created, the client starts a local SSE MCP server for the configured extension methods and passes it through `mcpServers`. Agents discover these methods through standard MCP `tools/list` and invoke them through `tools/call`. The legacy `clientCapabilities.experimental` declaration is still sent as metadata, but it is not relied on for tool discovery.

To verify this path, run the extension method test. It uses `mock-driver` by default and accepts a real agent id when needed:

```bash
pnpm extension-test
pnpm extension-test <agent-id>
```

---

### 4. Built-in Terminal Client Methods

ACP agents can call the client's terminal capability through the standard `terminal/*` client methods:

| Method                   | Behavior                                                                 |
| ------------------------ | ------------------------------------------------------------------------ |
| `terminal/create`        | Starts a local process and returns a `terminalId`.                       |
| `terminal/output`        | Returns captured output, truncation state, and exit status when present. |
| `terminal/wait_for_exit` | Waits for the process to exit and returns its exit status.               |
| `terminal/kill`          | Terminates the process while keeping the terminal available for output.  |
| `terminal/release`       | Frees terminal resources and invalidates the `terminalId`.               |

`AcpClientBuilder` registers local default handlers for `fs`, `session`, and `terminal`. These defaults are useful for standalone tests and local development. Upper-layer orchestrators can replace or wrap them for auditing, policy checks, remote execution, or coordinator-owned resource management:

```typescript
const client = new AcpClientBuilder()
  .withAgent("gemini")
  .withFileSystemHandler(new CoordinatorFileSystemHandler())
  .withPermissionHandler(new CoordinatorPermissionHandler())
  .withTerminalHandler(new AuditedTerminalHandler(new TerminalHandler()))
  .build();

const coordinatorOwnedClient = new AcpClientBuilder()
  .withAgent("gemini")
  .registerMethodHandler("fs", new CoordinatorFileSystemHandler())
  .registerMethodHandler("session", new CoordinatorPermissionHandler())
  .registerMethodHandler("terminal", new CoordinatorTerminalHandler())
  .build();
```

Use the dedicated `withFileSystemHandler()`, `withPermissionHandler()`, and `withTerminalHandler()` methods for common replacement paths. Use `registerMethodHandler(methodNameOrPrefix, handler)` when a coordinator needs to own any client method prefix or exact method name.

To verify the terminal lifecycle, run the terminal method test. It uses `mock-driver` by default and can target a real agent with an argument or `TERMINAL_TEST_AGENT`:

```bash
pnpm terminal-test
pnpm terminal-test <agent-id>
TERMINAL_TEST_AGENT=gemini pnpm terminal-test
```

---

## Supported Adapters

| Agent           | Connection | Auth Strategy    | Description                             |
| --------------- | ---------- | ---------------- | --------------------------------------- |
| **gemini**      | `acp`      | `auto`           | Google Gemini via `gemini-cli`          |
| **claude**      | `acp`      | `auto`           | Anthropic Claude via `claude-agent-acp` |
| **copilot**     | `acp`      | `none`           | GitHub Copilot via `@github/copilot`    |
| **codex**       | `acp`      | `auto`           | OpenAI Codex via `codex-acp`            |
| **kimi**        | `acp`      | `auto`           | Moonshot Kimi Code via `kimi-code`      |
| **opencode**    | `acp`      | `pre-configured` | OpenCode AI via `opencode-ai`           |
| **goose**       | `acp`      | `pre-configured` | Block/Square Goose via `goose`          |
| **kiro**        | `acp`      | `pre-configured` | AWS Kiro AI via `kiro-cli`              |
| **codebuddy**   | `acp`      | `auto`           | Tencent CodeBuddy via `codebuddy-code`  |
| **aider**       | `pty`      | `pre-configured` | AI coding assistant via PTY fallback    |
| **mock-driver** | `acp`      | `none`           | Local ACP mock driver used by tests     |

---

## Workspace Layout

```
src/
├── auth/             # Environment-auto, interactive, pre-configured strategies
├── client/           # Builder pattern, AcpClient lifecycle orchestrator
├── client-methods/   # Standard (FS, Terminal, Session) & Custom Extensions
├── connection/       # Protocol drivers (JSON-RPC / PTY abstraction)
├── core/             # Errors, shared types, ACP schemas
├── driver/           # Direction A Driver Wrapper layer (MockDriver)
├── driver-adapter/   # Agent definitions, quirks, and extensible registry
├── hook-gate/        # Event schemas & interceptor callbacks (Decoupled)
└── session/          # Session cache & store
tests/
├── driver.test.ts              # Direction A Driver contract integration tests
├── extension-method.test.ts    # MCP-backed extension method integration test
├── file-handler.test.ts        # Filesystem client method integration test
├── terminal-method.test.ts     # Terminal client method lifecycle integration test
└── hello.ts                    # Separated testing layer
```

---

### 4. Direction A Driver Contract Wrapper (`src/driver/`)

To support end-to-end multi-agent BCD pipelines, the micro-level `AcpClient` is wrapped inside the `MockDriver` adapter which implements `DriverRuntimeHandle` (from Direction C contract):

- **`sendPrompt(input: DriverPrompt): Promise<DriverRunResult>`**: High-level execution envelope returning structured patch artifacts and audit logs compatible with SQLite states.

To run the standalone driver test suite:

```bash
pnpm run build
pnpm run build:test
node dist/tests/driver.test.js
```

#### Cold-start phase marks (`driver.phase`)

A driver invocation's lifecycle cannot be split from the outside, so the runner emits paired
`driver.phase` events on the reserved audit channel (stderr lines prefixed with
`NEWIDE_DRIVER_EVENT`) for upper layers to attribute time against:

| `payload.phase` | Covers                                                      |
| --------------- | ----------------------------------------------------------- |
| `initialize`    | ACP initialize handshake                                    |
| `authenticate`  | Credential resolution and authentication                    |
| `session`       | Session creation or load; `payload.mode` is `create`/`load` |
| `shutdown`      | Connection and child-process teardown                       |

Contract:

- Each phase emits `boundary: "started"`, then `boundary: "completed"`. **Failures also emit
  completed**, carrying `ok: false` and `error`, so consumers close a phase unconditionally
  without branching.
- The envelope's `created_at` is this process's wall clock; `sequence` totally orders events
  within one turn.
- This is a **cross-repository contract**: `CommandDriverTransport` in `newide-scaffold` opens
  and closes `driver.<phase>` latency spans from these phase names. Renaming requires changing
  both sides.
- `spawn`, first output, and process exit are deliberately absent — they happen outside or after
  the ACP process, so the transport times them locally.

---

---

## Advanced Environment Configurations

| Variable               | Description                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `VERBOSE=1`            | Enable detailed debug logging and state outputs                                                  |
| `AUTO_APPROVE=1`       | Automatically approve all agent filesystem & terminal requests                                   |
| `TERMINAL_TEST_AGENT`  | Override the agent used by `pnpm terminal-test`; defaults to `mock-driver`                       |
| `CODEX_HOME`           | Point to a custom directory to override global Codex configuration (e.g., `./.codex`)            |
| `OPENCODE_CONFIG`      | Point to a custom JSON configuration file to override OpenCode config (e.g., `./.opencode.json`) |
| `GOOSE_PATH_ROOT`      | Point to a custom folder to sandbox Goose configuration, state, and data (e.g., `./.goose`)      |
| `GEMINI_API_KEY`       | API key for Gemini adapter                                                                       |
| `ANTHROPIC_API_KEY`    | API key for Claude adapter                                                                       |
| `OPENAI_API_KEY`       | API key for Codex/Aider                                                                          |
| `COPILOT_GITHUB_TOKEN` | GitHub Token with Copilot access for Copilot adapter (supports GH_TOKEN as fallback)             |

### OpenAI Codex Local Configuration (`CODEX_HOME`)

By default, the OpenAI Codex adapter (`codex-acp`) expects its configuration in the global `~/.codex/` directory. If you want to use a project-local configuration (e.g., to override API endpoints or sandbox behavior), you can point `CODEX_HOME` to a local folder:

1. Copy `.env.example` to `.env` and set `CODEX_HOME=./.codex`.
2. Create local configuration files inside the `.codex/` directory of your project:
   - Copy `.codex/config.toml.example` to `.codex/config.toml` and customize it.
   - Copy `.codex/auth.json.example` to `.codex/auth.json` and enter your credentials/API keys.

These local configuration files are ignored by git to protect your API keys and workspace-specific settings.

### OpenCode AI Local Configuration (`OPENCODE_CONFIG`)

By default, the OpenCode adapter (`opencode-ai`) expects its configuration in global directories like `~/.config/opencode/opencode.json`. You can completely override this and use a project-local configuration (e.g., to use **local Ollama models**) by pointing `OPENCODE_CONFIG` to a local JSON configuration:

1. Copy `.env.example` to `.env` and set `OPENCODE_CONFIG=./.opencode.json`.
2. Create your project-local configuration file:
   - Copy `.opencode.json.example` to `.opencode.json` and customize your models and providers (e.g., setting up a local Ollama connection).

This local configuration file is ignored by git to prevent local environment settings from leaking.

### Goose AI Local Configuration (`GOOSE_PATH_ROOT`)

By default, the Goose adapter (`goose`) expects its data, state, and configuration in standard global directories like `~/Library/Application Support/Block/goose/`. You can sandbox its configuration, state, and data to your project workspace by pointing `GOOSE_PATH_ROOT` to a project-local folder:

1. Copy `.env.example` to `.env` and set `GOOSE_PATH_ROOT=./.goose`. Also recommend setting `GOOSE_DISABLE_KEYRING=1` to store secrets inside your workspace plaintext configuration file instead of the OS system-wide secure keyring.
2. Run `goose configure` in your terminal to automatically generate its complex configuration and file structures locally within the `.goose/` workspace folder.

Because Goose's `config.yaml` is highly complex and platform-specific, **we do not provide a configuration template**. Setting up the local config via `goose configure` ensures that Goose generates a completely valid schema natively.

The `.goose/` workspace folder is ignored by git to prevent secrets and diagnostic caches from being tracked.

---

## Troubleshooting

- **Process Hangs**: Ensure you call `client.shutdown()` to clean up event loops and terminate child processes.
- **Sandbox Access Denied**: The filesystem handler enforces a strict sandbox. Ensure agents are accessing paths relative to the current working directory.
- **Goose/Kiro Driver Fails (ENOENT)**: If spawning the `goose` or `kiro` agent fails with an `ENOENT` error, check if the respective native CLI (`goose` or `kiro-cli`) is installed on your local machine. Both are natively compiled binaries and **do not** have npm packages.
