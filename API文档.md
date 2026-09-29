# ACP Client Prototype — API 文档

> 本文档面向开发者，说明 `acp-client-prototype` 的模块边界、公开接口、默认实现、扩展点和测试入口。README 用于快速上手；本文档用于理解代码结构并开始开发。

---

## 目录

- [1. 模块架构](#1-模块架构)
- [2. Public API Surface](#2-public-api-surface)
- [3. Builder 与依赖注入](#3-builder-与依赖注入)
- [4. 核心客户端 AcpClient](#4-核心客户端-acpclient)
- [5. 连接层](#5-连接层)
- [6. Agent Adapter 层](#6-agent-adapter-层)
- [7. Auth 与 Session](#7-auth-与-session)
- [8. Client Methods](#8-client-methods)
- [9. 自定义扩展方法与 MCP Bridge](#9-自定义扩展方法与-mcp-bridge)
- [10. PTY Fallback Parser](#10-pty-fallback-parser)
- [11. 事件与拦截器](#11-事件与拦截器)
- [12. 错误处理边界](#12-错误处理边界)
- [13. Driver 包装层](#13-driver-包装层)
- [14. 开发与测试入口](#14-开发与测试入口)

---

## 1. 模块架构

当前源码结构如下：

```text
src/
├── auth/             # AuthExecutor、AuthLayer 与认证策略
├── client/           # AcpClient 与 AcpClientBuilder
├── client-methods/   # Agent -> Client 能力处理：fs、permission、terminal、extension
├── connection/       # ACP JSON-RPC connection、PTY connection、PTY parser
├── core/             # 共享类型与本地错误类型
├── driver/           # 上层 DriverRuntimeHandle 包装与 MockDriver
├── driver-adapter/   # AgentAdapter、BaseAdapter、具体 agent adapter、registry
├── hook-gate/        # HookPoint、ClientInterceptors、gate 类型
└── session/          # SessionManager 与内存 session store
```

`src/index.ts` 是 package root export，不是 CLI 入口。上层集成应优先从 package root 导入稳定接口，避免依赖内部源码路径。

---

## 2. Public API Surface

package root 当前导出的稳定集成点包括：

| 分类             | 公开导出                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client 构建      | `AcpClientBuilder`, `ConnectionFactory`, `AcpClient`, `ClientState`, `AcpClientOptions`                                                                                             |
| Connection       | `AgentConnection`, `ConnectionEvent`, `ConnectionOptions`, `ConnectionType`, `InitializeResult`, `SessionRecord`, `TurnController`, `AcpConnection`, `PtyConnection`                |
| Adapter          | `AgentAdapter`, `ADAPTER_REGISTRY`                                                                                                                                                  |
| Auth/session     | `AuthCredential`, `AuthExecutor`, `AuthStrategy`, `AuthStrategyType`, `AuthLayer`, `SessionInfo`, `SessionManager`, `MemorySessionStore`                                            |
| Method handling  | `ClientMethodHandler`, `ClientMethodRouter`, `ExtensionMethod`, `loadExtensionConfig`                                                                                               |
| 默认本地 handler | `FileSystemHandler`, `PermissionHandler`, `TerminalHandler`, `TerminalHandlerOptions`                                                                                               |
| PTY parser       | `PtyOutputParser`, `PtyParserContext`, `PtyParserResult`, `PtyStream`, `PtyTurnResult`, `DefaultPtyParser`, `AiderPtyParser`, `parseAiderEditBlocks`                                |
| Hook/gate        | `HookPoint`, `HookContext`, `GatePoint`, `ClientInterceptors`, `GateRequest`, `GateResult`                                                                                          |
| ACP/driver 类型  | `ClientCapabilities`, `McpServerConfig`, `SessionNotification`, `ToolCallUpdate`, `PermissionRequest`, `DriverRuntimeHandle`, `DriverRunResult`, `ArtifactRef`, `ContextPackRef` 等 |
| 错误类型         | `AcpError`, `AgentSpawnError`, `AuthError`, `SessionError`, `ConfigurationError`, `PermissionDeniedError`, `TransportError`, `PtyError`                                             |
| Driver           | `MockDriver` 以及 `src/driver/interface.ts` 中的 driver contract 类型                                                                                                               |

内部实现不作为 public API 承诺，例如 `ExtensionMcpServer`、JSON-RPC/SSE 私有类型、parser helper 的内部组合逻辑。

---

## 3. Builder 与依赖注入

`AcpClientBuilder` 是推荐构建入口。它默认组装 agent adapter、connection、auth executor、session manager 和 client method router。

```typescript
import { AcpClientBuilder } from "acp-client-prototype";

const client = new AcpClientBuilder()
  .withAgent("gemini")
  .withVerbose(process.env.VERBOSE === "1")
  .withAutoApprove(true)
  .withSandboxDir(process.cwd())
  .build();
```

高级注入接口：

| 方法                                                 | 作用                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `withAgent(agentId)`                                 | 指定 `ADAPTER_REGISTRY` 中的 agent。                                      |
| `withVerbose(verbose)`                               | 开启连接和状态调试输出。                                                  |
| `withAutoApprove(autoApprove)`                       | 默认 permission handler 自动选择第一个 permission option。                |
| `withSandboxDir(sandboxDir)`                         | 设置默认 `FileSystemHandler` 的沙箱根目录。                               |
| `withExtensionConfig(configPath)`                    | 加载扩展方法描述，用于 MCP tool bridge。                                  |
| `registerExtensionHandler(methodName, handler)`      | 注册扩展方法处理器。                                                      |
| `registerMethodHandler(methodNameOrPrefix, handler)` | 注册或覆盖任意精确方法名或方法前缀。                                      |
| `withFileSystemHandler(handler)`                     | 替换 `fs/*` client methods。                                              |
| `withPermissionHandler(handler)`                     | 替换 `session/request_permission`。                                       |
| `withTerminalHandler(handler)`                       | 替换 `terminal/*` client methods。                                        |
| `withMethodRouter(router)`                           | 注入完整 method router。                                                  |
| `withAuthLayer(authLayer)`                           | 注入 `AuthExecutor`。                                                     |
| `withSessionManager(sessionManager)`                 | 注入 `SessionManager`。                                                   |
| `withConnection(connection)`                         | 直接注入 connection 实例。                                                |
| `withConnectionFactory(factory)`                     | 按 `AgentAdapter` 动态创建 connection。                                   |
| `withInterceptors(interceptors)`                     | 注入 client interceptors；当前执行路径实际接入的是 `output` interceptor。 |

`withConnection()` 和 `withConnectionFactory()` 不能同时使用；否则 `build()` 抛出 `ConfigurationError`。

默认情况下 Builder 会注册：

- `fs` -> `FileSystemHandler`
- `session` -> `PermissionHandler`
- `terminal` -> `TerminalHandler`
- `registerMethodHandler()` / `registerExtensionHandler()` 提供的用户 handler

---

## 4. 核心客户端 AcpClient

`AcpClient` 负责生命周期编排：

1. `initialize(customCapabilities?)`：启动连接、发送 ACP initialize、声明 `clientCapabilities`。
2. `authenticate()`：根据 adapter 的 auth strategy 调用 `AuthExecutor`。
3. `createSession(cwd, mcpServers?)`：创建 session，并附加扩展方法 MCP server。
4. `sendPrompt(message)`：向当前 session 发送 prompt，返回 `TurnController`。
5. `shutdown()`：断开 connection，停止扩展 MCP server，清理状态。

状态机：

- `disconnected`
- `initializing`
- `authenticated`
- `ready`
- `busy`
- `shutting_down`

`initialize()` 默认声明的 client capabilities：

```typescript
{
  fs: { readTextFile: true, writeTextFile: true, listDirectory: true },
  terminal: true,
  experimental: { ...extensionMetadata }
}
```

扩展方法的真实发现路径是 MCP tool bridge；`clientCapabilities.experimental` 只作为兼容性元数据。

---

## 5. 连接层

### `AgentConnection`

`AgentConnection` 抽象 ACP JSON-RPC 和 PTY fallback 两类连接。核心方法包括：

- `connect(options)`
- `disconnect()`
- `initialize(params)`
- `authenticate(methodId, authMethod)`
- `createSession(cwd, mcpServers?)`
- `sendPrompt(sessionId, message)`
- `cancel(sessionId)`
- `onEvent(signal?)`
- `setMethodRouter(router)`

### `AcpConnection`

`AcpConnection` 基于 `@agentclientprotocol/sdk` 的 `ClientSideConnection`。它只负责：

- 启动 agent ACP 子进程。
- 将 stdin/stdout 包装为 SDK stream。
- 把 Agent -> Client 的 ACP client method callback 转发给 `ClientMethodRouter`。
- 将 session/update 转为 `ConnectionEvent`。

它不提供文件、权限、终端或扩展方法的 stub fallback。若上层直接构造 `AcpConnection`，必须先调用 `setMethodRouter(...)`。缺失 router 时会抛 ACP SDK `RequestError.methodNotFound`，让 agent 看到结构化 JSON-RPC error。

### `PtyConnection`

`PtyConnection` 用于 Aider 等不支持 ACP 的 TUI agent。它通过 `node-pty` 启动进程，并使用 `PtyOutputParser` 将字节流转换为统一的 `ConnectionEvent` 和 turn result。

---

## 6. Agent Adapter 层

`AgentAdapter` 位于 `src/driver-adapter/`，负责封装不同 agent 的启动方式、环境变量、认证策略和 PTY parser。

关键接口：

```typescript
interface AgentAdapter {
  readonly agentId: string;
  readonly name: string;
  readonly description: string;
  readonly connectionType: ConnectionType;

  resolveCommand(): { command: string; args: string[] };
  resolveEnv(): Record<string, string | undefined>;
  resolveAuthStrategy(): AuthStrategyType;

  beforeSpawn?(): Promise<void>;
  normalizeResponse?(method: string, raw: unknown): unknown;
  authEnvMap?: Record<string, string>;
  createPtyParser?(): PtyOutputParser | undefined;
}
```

当前 registry 默认包含：`gemini`、`claude`、`codex`、`kimi`、`codebuddy`、`copilot`、`opencode`、`goose`、`kiro`、`aider`、`mock-driver`。

新增 agent 的通常步骤：

1. 在 `src/driver-adapter/adapters/` 新增 adapter。
2. 继承 `BaseAdapter`，填写 `agentId`、`connectionType`、命令、参数和 auth strategy。
3. ACP agent 使用 `connectionType: "acp"`；PTY fallback agent 使用 `connectionType: "pty"` 并实现 `createPtyParser()`。
4. 在 `src/driver-adapter/registry.ts` 注册。

---

## 7. Auth 与 Session

### Auth

`AuthExecutor` 是上层可替换的认证执行接口：

```typescript
interface AuthExecutor {
  execute(
    strategyType: AuthStrategyType,
    authMethods: any[],
    verbose?: boolean
  ): Promise<AuthCredential | null>;
}
```

默认 `AuthLayer` 支持：

- `none`
- `pre-configured`
- `env-auto`
- `interactive`
- `auto`

上层 coordinator 可以通过 `withAuthLayer()` 接管认证策略选择和凭证来源。

### Session

`SessionManager` 负责保存当前 session 信息。默认实现是 `MemorySessionStore`。上层可以通过 `withSessionManager()` 替换为持久化 store。

---

## 8. Client Methods

Client methods 是 Agent 调用宿主客户端能力的入口，统一由 `ClientMethodRouter` 分发。router 先尝试精确方法名，再尝试方法前缀：

- `fs/read_text_file` -> 精确 handler 或 `fs` handler
- `terminal/create` -> 精确 handler 或 `terminal` handler
- `custom/foo` -> 精确 handler 或 `custom` handler

### FileSystemHandler

默认文件系统 handler 提供：

| 方法                 | 行为                                        |
| -------------------- | ------------------------------------------- |
| `fs/read_text_file`  | 在 sandbox 内读取文本文件。                 |
| `fs/write_text_file` | 在 sandbox 内写入文本文件，必要时创建目录。 |
| `fs/list_directory`  | 在 sandbox 内列出目录条目。                 |

路径会通过 `path.resolve` 与 `path.relative` 校验，禁止逃逸 `baseDir`。

### PermissionHandler

默认 permission handler 处理 `session/request_permission`：

- `AUTO_APPROVE=1` 或 `withAutoApprove(true)` 时选择第一个 option。
- 否则通过 `@inquirer/prompts` 让用户选择。
- 用户取消时返回 ACP schema 中的 `{ outcome: { outcome: "cancelled" } }`，不是抛错。

### TerminalHandler

默认 terminal handler 提供完整 ACP terminal 生命周期：

| 方法                     | 行为                                              |
| ------------------------ | ------------------------------------------------- |
| `terminal/create`        | 启动本地进程，创建输出缓冲区，返回 `terminalId`。 |
| `terminal/output`        | 返回累计输出、截断状态和可用时的 `exitStatus`。   |
| `terminal/wait_for_exit` | 等待进程退出并返回 `{ exitCode, signal }`。       |
| `terminal/kill`          | 终止进程，但保留 terminal，允许继续读取最终输出。 |
| `terminal/release`       | 销毁流、释放资源，并使 `terminalId` 失效。        |

上层如果需要审计、远程执行、策略控制或资源托管，应通过 `withTerminalHandler()` 或 `registerMethodHandler("terminal", handler)` 替换/包装默认实现。

---

## 9. 自定义扩展方法与 MCP Bridge

扩展方法通过 MCP 暴露给 agent，不依赖 agent 从 `clientCapabilities.experimental` 发现工具。

流程：

1. `withExtensionConfig("extensions.yaml")` 加载方法描述。
2. `registerExtensionHandler("custom/name", handler)` 注册处理器。
3. `createSession()` 时 client 启动本地 SSE MCP server。
4. MCP server 通过 `mcpServers` 传给 agent。
5. Agent 通过 `tools/list` 发现工具，通过 `tools/call` 调用。
6. MCP server 将调用转发到 `ClientMethodRouter`。

扩展配置示例：

```yaml
methods:
  - name: "custom/greet"
    description: "Greet a user"
    params:
      name: "string"
```

handler 示例：

```typescript
import { RequestError } from "@agentclientprotocol/sdk";
import type { ClientMethodHandler } from "acp-client-prototype";

class GreetHandler implements ClientMethodHandler {
  async handle(method: string, params: any): Promise<any> {
    if (method !== "custom/greet") {
      throw RequestError.methodNotFound(method);
    }
    return { greeting: `Hello ${params.name ?? "user"}` };
  }
}
```

---

## 10. PTY Fallback Parser

PTY fallback 用于不支持 ACP 的 TUI agent。它的关键设计是把“连接生命周期”和“输出解析”分离：

- `PtyConnection` 负责启动进程、发送 prompt、接收 stdout/stderr、取消和退出。
- `PtyOutputParser` 负责把字节流解释为 `ConnectionEvent` 和 turn result。
- 每个 PTY agent 可以拥有自己的 parser，例如 Aider 使用 `AiderPtyParser`。

接口：

```typescript
interface PtyOutputParser {
  readonly id: string;
  onTurnStart?(context: PtyParserContext, prompt: string): ConnectionEvent[];
  onData(context: PtyParserContext, stream: PtyStream, chunk: string): PtyParserResult;
  onExit?(context: PtyParserContext, exitCode: number, signal?: number): PtyParserResult;
  onCancel?(context: PtyParserContext): PtyParserResult;
}
```

新增 PTY fallback agent 的通常步骤：

1. 实现一个新的 `PtyOutputParser`。
2. 为该 agent 实现 adapter，并在 `createPtyParser()` 中返回 parser。
3. 在 registry 注册 adapter。
4. 在 `tests/pty-parsers/` 添加 parser 单元测试。
5. 运行 `pnpm parser-test`。

---

## 11. 事件与拦截器

`AcpClient` 继承 Node `EventEmitter`，公开以下常用事件：

| 事件                  | 说明                               |
| --------------------- | ---------------------------------- |
| `stateChange`         | Client 状态变化。                  |
| `event`               | 原始 `ConnectionEvent`。           |
| `agent_message_chunk` | Agent 文本输出流。                 |
| `agentMessage`        | `agent_message_chunk` 的兼容别名。 |
| `agent_thought_chunk` | Agent thought/reasoning 输出流。   |
| `tool_call`           | Agent 报告工具调用开始。           |
| `tool_call_update`    | Agent 报告工具调用状态更新。       |
| `stderr`              | agent 子进程 stderr。              |

当前实现会发出的生命周期 hook 事件包括 `pre:connect`、`post:connect`、`pre:initialize`、`post:initialize`、`pre:authenticate`、`post:authenticate`、`pre:session:create`、`post:session:create`、`pre:prompt`、`pre:disconnect`、`post:disconnect`。

`ClientInterceptors` 当前定义了 `output` 与 `permission`，但 `AcpClient` 实际执行路径目前只调用 `output` interceptor。不要把 `permission` interceptor 当作已接入的权限阻断机制；生产权限接管应优先替换 `PermissionHandler`。

---

## 12. 错误处理边界

错误分为两类：

### Agent 可见错误

Agent 通过 ACP client method 或 MCP tool call 调用宿主能力时，必须返回 JSON-RPC 语义错误。实现上应抛 `@agentclientprotocol/sdk` 的 `RequestError`：

- `RequestError.methodNotFound(method)`
- `RequestError.invalidParams(data, message)`
- `RequestError.resourceNotFound(uri)`
- `RequestError.internalError(data, message)`
- 必要时可以使用 `new RequestError(code, message, data)` 表达应用级错误，例如权限拒绝。

原因：ACP SDK 只会对 `RequestError` 原样序列化 `code/message/data`。普通 `Error` 或项目自定义 `AcpError` 会被 SDK 包装成 `Internal error`，agent 无法稳定看到语义化原因。

默认 handler 的策略：

- 文件不存在 -> `resourceNotFound`
- 参数错误 -> `invalidParams`
- sandbox/权限拒绝 -> application error `-32003`
- terminal 已释放或不存在 -> `resourceNotFound`
- terminal kill 底层失败 -> `internalError`，附带 `terminalId/reason`
- permission 用户取消 -> 返回 `{ outcome: { outcome: "cancelled" } }`

### 本地宿主错误

构建、连接、认证、session 生命周期等 host-side 错误使用项目自定义错误：

- `ConfigurationError`
- `AgentSpawnError`
- `AuthError`
- `SessionError`
- `TransportError`
- `PtyError`

这些错误面向上层 orchestrator/coordinator，而不是作为 agent method 调用结果。

---

## 13. Driver 包装层

`src/driver/` 提供宏观 driver contract 包装。`MockDriver` 实现 `DriverRuntimeHandle`，用于测试和上层流水线适配。

核心入口：

```typescript
sendPrompt(input: DriverPrompt): Promise<DriverRunResult>
```

该层面向更上层的 multi-agent/coordinator 系统，返回结构化运行结果、artifact 引用和审计信息。它不替代底层 ACP client methods。

---

## 14. 开发与测试入口

常用命令：

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm run build:test
```

集成/专项测试：

```bash
pnpm hello mock-driver
pnpm file-test
pnpm extension-test
pnpm terminal-test
pnpm parser-test
```

直接运行 node:test：

```bash
pnpm run build
pnpm run build:test
node --test dist/tests/**/*.test.js
```

测试目录：

```text
tests/
├── acp-connection-routing.test.ts
├── driver.test.ts
├── extension-method.test.ts
├── file-handler.test.ts
├── hello.ts
├── pty-parsers/
│   ├── aider-parser.test.ts
│   └── default-parser.test.ts
├── public-api.test.ts
└── terminal-method.test.ts
```
