# acp-client-prototype

[![EN](https://img.shields.io/badge/Language-English-blue.svg)](README.md)
[![ZH](https://img.shields.io/badge/Language-中文-red.svg)](README.zh.md)

# Universal ACP Client

一个模块化、高可扩展的 ACP (Agent Client Protocol) 宿主客户端类库，用于将标准的 AI 编码 Agent (Gemini, Claude, Codex) 以及基于 TUI 的工具 (Aider) 无缝接入上层系统（例如 Multi-Agent 编排框架、IDE 插件等）。

基于 `@agentclientprotocol/sdk` 构建。

---

## 核心设计特性

- **Builder 模式**: 抽象出简单易用的 `AcpClientBuilder`，通过链式调用进行 Client 实例的参数化构建。
- **状态机与生命周期暴露**: 暴露 Client 全生命周期状态 (`disconnected`, `initializing`, `authenticated`, `ready`, `busy`, `shutting_down`)，并支持实时状态变更事件。
- **配置驱动的方法扩展**: 支持通过 `YAML` 或 `JSON` 配置文件定义新增方法描述，并配合 Builder 注册自定义处理器（Handler），快速完成 ACP/MCP 扩展。
- **完全隔离的测试层**: 测试代码与核心库分离，位于独立的 `tests/` 目录中，支持独立编译，且测试代码完全使用 Client 暴露的公开 Builder 和接口。

---

## 快速开始

### 0. 环境要求

- Node.js `>=22.22.1`
- pnpm `>=11.8.0`

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置凭证

```bash
cp .env.example .env
# 编辑 .env 并填入 API Key (例如 GEMINI_API_KEY)
```

### 3. 运行隔离的集成测试

```bash
pnpm hello gemini "Hello World"
```

---

## 核心 API 与接口规范

### 1. 使用 Builder 构建 Client 实例 (`AcpClientBuilder`)

上层使用者无须关注复杂的连接驱动、鉴权策略、会话管理的底层组装。使用 `AcpClientBuilder` 完成一站式配置：

```typescript
import { AcpClientBuilder } from "acp-client-prototype";

const builder = new AcpClientBuilder()
  .withAgent("gemini") // 选择要连接的 Agent 标识 (如 gemini, claude)
  .withVerbose(true) // 开启详细调试输出
  .withAutoApprove(true) // 自动批准所有敏感权限请求
  .withSandboxDir("/my-sandbox") // 指定文件系统沙箱路径
  .withExtensionConfig("extensions.yaml") // 载入自定义 ACP 扩展协议描述文件
  .registerExtensionHandler("custom/greet", new MyCustomHandler()); // 注册自定义方法处理器

const client = builder.build();
```

#### Public API Surface

上层集成代码应优先从 package root 导入扩展契约，而不是依赖内部源码路径：

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

root export 按稳定集成点组织：

| 分类              | 公开导出                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| Client 构建       | `AcpClientBuilder`, `AcpClient`, `AcpClientOptions`, `ConnectionFactory`                             |
| Method handling   | `ClientMethodHandler`, `ClientMethodRouter`, `ExtensionMethod`, `loadExtensionConfig`                |
| 默认本地 handler  | `FileSystemHandler`, `PermissionHandler`, `TerminalHandler`, `TerminalHandlerOptions`                |
| Connection 扩展   | `AgentConnection`, `ConnectionEvent`, `TurnController`, `AcpConnection`, `PtyConnection`             |
| Adapter 扩展      | `AgentAdapter`, `ADAPTER_REGISTRY`                                                                   |
| Auth/session 扩展 | `AuthExecutor`, `AuthLayer`, `SessionManager`, `MemorySessionStore`                                  |
| PTY parser 扩展   | `PtyOutputParser`, `PtyParserContext`, `DefaultPtyParser`, `AiderPtyParser`                          |
| 协议类型          | `ClientCapabilities`, `McpServerConfig`, `SessionNotification`, `ToolCallUpdate` 及相关 ACP 数据类型 |

extension MCP server 内部实现、私有 parser helper 等实现细节不属于 root public API。

#### Client Method Routing Policy

`AcpClientBuilder` 会在 connection 被使用前安装 `ClientMethodRouter`。如果上层直接构造 `AcpConnection`，必须先调用 `setMethodRouter(...)`，再允许 ACP agent 调用 client methods。缺少 router 或缺少 handler 时会直接失败；connection 不会返回文件、权限、终端或扩展方法的 stub 结果。

在生产集成中，项目内置的 handler、auth、session、connection 都只是默认实现。上层 orchestrator/coordinator 可以在构建阶段替换方法处理器、认证执行器、会话管理器或底层连接：

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

### 2. Client 状态管理与数据出口

`AcpClient` 作为统一的主体，只负责网络通信、协议解析与状态编排。所有的输入命令（入口）与事件流（出口）完全交给上层进行接管与控制。

#### Client 连接与 turn 状态机 (`ClientState`)

宿主状态可通过 `client.getState()` 进行实时查询，包含以下状态：

- `disconnected`: Agent 子进程未启动。
- `initializing`: 进程已启动，正在执行 initialize 协议握手。
- `authenticated`: 握手成功，客户端已自动解析并执行完成 Agent 对应策略的鉴权。
- `ready`: 会话创建完毕，处于闲置状态，随时准备接收上层 Prompt 指令。
- `busy`: 正在向远端 Agent 发送指令并等待返回，或者 Agent 正在流式输出/调用工具中。
- `shutting_down`: 进程和资源释放中。

#### 强类型事件参考手册 (Type-Safe Event Reference)

`AcpClient` 类为 Node 原生 `EventEmitter` 的 `emit`、`on` 和 `once` 提供了 TypeScript 方法重载。现代 IDE（如 VS Code）会对这些事件名和回调参数提供补全与类型提示。

以下是客户端支持的完整类型化事件表：

| 事件名称 (Event Name) | 回调参数类型 (Parameter Type)                    | 事件描述                                               |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| `stateChange`         | `(newState: ClientState, oldState: ClientState)` | 任何连接状态、会话执行状态发生转换时触发。             |
| `event`               | `(event: ConnectionEvent)`                       | 底层连接层收到的所有原始数据包包装。                   |
| `agent_message_chunk` | `(payload: any)`                                 | Agent 流式返回的文本消息 Token 片段。                  |
| `agentMessage`        | `(payload: any)`                                 | `agent_message_chunk` 的兼容别名。                     |
| `agent_thought_chunk` | `(payload: any)`                                 | 支持推理思维链的 Agent 正在流式输出的思考 Token 片段。 |
| `tool_call`           | `(payload: any)`                                 | Agent 请求调用特定的主机/客户端工具/方法。             |
| `tool_call_update`    | `(payload: any)`                                 | 被调用的工具执行完成、失败等执行状态更新。             |
| `stderr`              | `(payload: any)`                                 | 远端 Agent 进程抛出的原始标准错误诊断输出。            |

生命周期 hook 事件也通过同一个 `EventEmitter` 暴露，例如 `pre:connect`、`post:initialize`、`pre:prompt` 和 `post:disconnect`。

```typescript
// 支持拼写补全与类型校验
client.on("stateChange", (newState, oldState) => {
  // TypeScript 会自动推断出 newState 与 oldState 为 ClientState 类型！
});
```

#### 订阅细粒度数据流 (出口)

上层程序可直接订阅特定的事件名称，实现高亮文本、日志归档或人工审核拦截：

```typescript
// 监听 Agent 输出的文本消息流
client.on("agent_message_chunk", (payload) => {
  process.stdout.write(payload.update.content.text);
});

// 监听 Agent 思考的思维链消息流
client.on("agent_thought_chunk", (payload) => {
  console.log(`[思考中...] ${payload.update.content.text}`);
});

// 拦截并接管工具调用
client.on("tool_call", (payload) => {
  console.log(`[工具调用拦截] Agent 请求执行: ${payload.update.title}`);
});
```

---

### 3. 自定义方法扩展 (MCP Tool Bridge)

要为 Client 增加新的方法/能力，扩展者**完全不需要修改 Client 核心代码**。配置方法描述、注册处理器后，Client 会把这些方法暴露为 MCP tools，供 ACP Agent 发现和调用。

#### 第一步：在配置文件中描述方法 (`extensions.yaml`)

```yaml
methods:
  - name: "custom/greet"
    description: "Greet a user with a customized styling theme"
    params:
      name: "string"
      style: "string"
```

#### 第二步：编写方法处理器 (`ClientMethodHandler`)

编写一个类，实现 `ClientMethodHandler` 接口：

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

对于 Agent 可见的 client method 或 MCP tool call，如果希望 Agent 看见结构化的 JSON-RPC `code`、`message` 和 `data`，应抛出 ACP SDK 的 `RequestError`。普通 JavaScript `Error` 会在协议边界被视为内部错误。

#### 第三步：使用 Builder 注册

```typescript
const builder = new AcpClientBuilder()
  .withAgent("gemini")
  .withExtensionConfig("extensions.yaml")
  .registerExtensionHandler("custom/greet", new MyCustomHandler());
```

在创建 session 时，Client 会为已配置的扩展方法启动本地 SSE MCP server，并通过 `mcpServers` 传给 Agent。Agent 通过标准 MCP `tools/list` 发现这些方法，通过 `tools/call` 调用。`clientCapabilities.experimental` 仍会作为兼容性元数据发送，但不再依赖它完成工具发现。

可以用扩展方法测试验证这条链路。默认使用 `mock-driver`，也可以传入真实 Agent 标识：

```bash
pnpm extension-test
pnpm extension-test <agent-id>
```

---

### 4. 内置终端 Client Methods

ACP Agent 可以通过标准 `terminal/*` client methods 调用宿主客户端的终端能力：

| 方法                     | 行为                                                   |
| ------------------------ | ------------------------------------------------------ |
| `terminal/create`        | 启动本地进程并返回 `terminalId`。                      |
| `terminal/output`        | 返回已捕获输出、截断状态，以及可用时的退出状态。       |
| `terminal/wait_for_exit` | 等待进程退出并返回退出状态。                           |
| `terminal/kill`          | 终止进程，但保留 terminal，供 Agent 继续读取最终输出。 |
| `terminal/release`       | 释放终端资源，并使对应 `terminalId` 对后续调用失效。   |

`AcpClientBuilder` 默认注册本地 `fs`、`session` 和 `terminal` handler。这些默认实现适合独立运行、样例和本地测试；在更大的 orchestrator/coordinator 中，上层可以替换或包装它们，以实现审计、策略控制、远程执行，或由协调层托管资源生命周期：

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

常规替换优先使用 `withFileSystemHandler()`、`withPermissionHandler()` 和 `withTerminalHandler()`。如果上层需要接管任意 client method 前缀或精确方法名，可以使用 `registerMethodHandler(methodNameOrPrefix, handler)`。

可以用终端方法测试验证完整生命周期。默认使用 `mock-driver`，也可以通过参数或 `TERMINAL_TEST_AGENT` 指定真实 Agent：

```bash
pnpm terminal-test
pnpm terminal-test <agent-id>
TERMINAL_TEST_AGENT=gemini pnpm terminal-test
```

---

## 已支持的适配器列表

| Agent 标识      | 连接方式 | 鉴权策略         | 描述                                          |
| --------------- | -------- | ---------------- | --------------------------------------------- |
| **gemini**      | `acp`    | `auto`           | 通过 `gemini-cli` 连接 Google Gemini          |
| **claude**      | `acp`    | `auto`           | 通过 `claude-agent-acp` 连接 Anthropic Claude |
| **copilot**     | `acp`    | `none`           | 通过 `@github/copilot` 连接 GitHub Copilot    |
| **codex**       | `acp`    | `auto`           | 通过 `codex-acp` 连接 OpenAI Codex            |
| **kimi**        | `acp`    | `auto`           | 通过 `kimi-code` 连接 Moonshot Kimi Code      |
| **opencode**    | `acp`    | `pre-configured` | 通过 `opencode-ai` 连接 OpenCode AI           |
| **goose**       | `acp`    | `pre-configured` | 通过 `goose` 连接 Block/Square Goose AI       |
| **kiro**        | `acp`    | `pre-configured` | 通过 `kiro-cli` 连接 AWS Kiro AI              |
| **codebuddy**   | `acp`    | `auto`           | 通过 `codebuddy-code` 连接腾讯 CodeBuddy      |
| **aider**       | `pty`    | `pre-configured` | 通过 PTY 伪终端兜底连接 AI 编码助手 Aider     |
| **mock-driver** | `acp`    | `none`           | 测试默认使用的本地 ACP mock driver            |

---

## 项目架构图

```
src/
├── auth/             # 统一鉴权策略（自动、交互、预配置等）
├── client/           # Builder 模式实现与 Client 核心生命周期编排器
├── client-methods/   # 宿主内置功能 (FS 沙箱、虚拟终端等) 与自定义扩展处理器
├── connection/       # 底层连接驱动（ACP JSON-RPC / PTY）
├── core/             # 通用错误、类型定义及协议规范定义
├── driver/           # A方向 Driver 包装层 (MockDriver)
├── driver-adapter/   # Agent 定义、差异抹平及扩展注册表
├── hook-gate/        # 事件点位定义与拦截回调契约 (解耦)
└── session/          # 会话存储与管理
tests/
├── driver.test.ts              # A方向 Driver 契约集成测试层
├── extension-method.test.ts    # 基于 MCP 的扩展方法集成测试
├── file-handler.test.ts        # 文件系统 client method 集成测试
├── terminal-method.test.ts     # 终端 client method 生命周期集成测试
└── hello.ts                    # 分离出的独立测试层
```

---

### 4. A 方向 Driver 契约包装层 (`src/driver/`)

为了支持端到端多智能体 BCD 流水线，微观协议通道层的 `AcpClient` 被包裹在 `MockDriver` 适配器中，该适配器完全实现了 C 方向要求的 `DriverRuntimeHandle` 接口：

- **`sendPrompt(input: DriverPrompt): Promise<DriverRunResult>`**：宏观任务执行信封，向 C 方向返回标准的补丁产物引用与审计日志。

执行独立的 A 方向驱动集成测试契约套件：

```bash
pnpm run build
pnpm run build:test
node dist/tests/driver.test.js
```

#### 冷启动分段埋点（`driver.phase`）

一次驱动调用的生命周期从外部无法拆分，因此 runner 会在保留审计通道（stderr 上以
`NEWIDE_DRIVER_EVENT` 为前缀的行）成对发出 `driver.phase` 事件，供上层做耗时归因：

| `payload.phase` | 覆盖范围                                            |
| --------------- | --------------------------------------------------- |
| `initialize`    | ACP 初始化握手                                      |
| `authenticate`  | 凭据解析与认证                                      |
| `session`       | 会话创建或加载；`payload.mode` 为 `create` / `load` |
| `shutdown`      | 连接与子进程收尾                                    |

约定：

- 每段先发 `boundary: "started"`，再发 `boundary: "completed"`；**失败同样发 completed**，
  带 `ok: false` 与 `error`。上层关闭埋点的逻辑因此无条件、无分支。
- 信封里的 `created_at` 是本进程墙钟，`sequence` 保证同一 turn 内全序。
- 这是**跨仓库契约**：`newide-scaffold` 的 `CommandDriverTransport` 按这些段名开闭
  `driver.<phase>` 耗时 span，改名必须两侧同时改。
- `spawn`、首个输出、进程退出不在表中——它们发生在 ACP 进程之外或之后，由 transport
  侧自行计时。

---

---

## 核心环境变量

| 变量名                 | 描述                                                                       |
| ---------------------- | -------------------------------------------------------------------------- |
| `VERBOSE=1`            | 开启详细的调试与状态转移日志                                               |
| `AUTO_APPROVE=1`       | 自动批准所有 Agent 对文件系统、终端操作的授权请求                          |
| `TERMINAL_TEST_AGENT`  | 覆盖 `pnpm terminal-test` 使用的 Agent；默认使用 `mock-driver`             |
| `CODEX_HOME`           | 指向自定义目录以覆盖全局 Codex 配置 (例如 `./.codex`)                      |
| `OPENCODE_CONFIG`      | 指向自定义 JSON 配置文件以覆盖全局 OpenCode 配置 (例如 `./.opencode.json`) |
| `GOOSE_PATH_ROOT`      | 指向自定义目录以隔离/沙箱化 Goose 的配置、状态和数据目录 (例如 `./.goose`) |
| `GEMINI_API_KEY`       | Gemini 适配器的 API Key                                                    |
| `ANTHROPIC_API_KEY`    | Claude 适配器的 API Key                                                    |
| `OPENAI_API_KEY`       | Codex/Aider 的 API Key                                                     |
| `COPILOT_GITHUB_TOKEN` | Copilot 适配器的 GitHub Access Token（支持使用 GH_TOKEN 作为备用）         |

### OpenAI Codex 本地配置 (`CODEX_HOME`)

默认情况下，OpenAI Codex 适配器 (`codex-acp`) 会读取全局的 `~/.codex/` 目录。如果你希望使用项目本地的配置（例如重写 API 端点或沙箱行为），你可以将 `CODEX_HOME` 指向一个本地文件夹：

1. 将 `.env.example` 复制为 `.env` 并设置 `CODEX_HOME=./.codex`。
2. 在项目根目录 `.codex/` 文件夹中创建本地配置文件：
   - 将 `.codex/config.toml.example` 复制为 `.codex/config.toml` 并根据需要进行定制。
   - 将 `.codex/auth.json.example` 复制为 `.codex/auth.json` 并填入你的 API Key 或凭据。

这些本地配置文件已添加到 `.gitignore` 中，以防止你的 API Key 和工作区特定配置被误提交到 Git。

### OpenCode AI 本地配置 (`OPENCODE_CONFIG`)

默认情况下，OpenCode 适配器 (`opencode-ai`) 会读取全局的配置文件（例如 macOS/Linux 下的 `~/.config/opencode/opencode.json`）。如果你希望使用项目本地的配置（例如使用 **本地 Ollama 模型**），你可以将 `OPENCODE_CONFIG` 指向一个项目本地的 JSON 配置文件：

1. 将 `.env.example` 复制为 `.env` 并设置 `OPENCODE_CONFIG=./.opencode.json`。
2. 在项目根目录创建本地配置文件：
   - 将 `.opencode.json.example` 复制为 `.opencode.json` 并定制你的模型和 Provider（例如配置本地 Ollama 节点）。

这个本地配置文件已添加到 `.gitignore` 中，以防止项目环境特定配置被误提交到 Git。

### Goose AI 本地配置 (`GOOSE_PATH_ROOT`)

默认情况下，Goose 适配器 (`goose`) 会将配置、数据和状态存存放于系统的全局共享目录中（例如 macOS 下的 `~/Library/Application Support/Block/goose/`）。为了在项目工作区内部隔离和沙箱化 Goose 的环境，你可以将 `GOOSE_PATH_ROOT` 指向本地文件夹：

1. 将 `.env.example` 复制为 `.env` 并设置 `GOOSE_PATH_ROOT=./.goose`。同时推荐设置 `GOOSE_DISABLE_KEYRING=1`，强制让 Goose 将密钥保存在工作区明文文件中，而不是写入系统的全局安全密钥链。
2. 在终端运行 `goose configure`，它会自动在项目本地的 `.goose/` 目录中自动生成所有的运行文件夹与复杂的配置文件结构。

由于 Goose 的 `config.yaml` 极度复杂且高度依赖平台/运行环境，**项目本身不提供配置模版**。通过本地运行 `goose configure` 可以确保 Goose 以原生方式生成 100% 正确、合法的配置文件。

整个 `.goose/` 目录均已通过 `.gitignore` 自动忽略，以确保运行缓存、复杂的本地配置和密钥绝不会被提交到 Git。

---

## 故障排查

- **进程挂起**: 请务必确保在业务结束时调用了 `client.shutdown()` 进而清理资源、断开底层子进程。
- **沙箱文件访问拒绝**: 内置的 FileSystem Handler 强制推行沙箱安全策略。请确保 Agent 访问的路径均位于当前运行工作目录下。
- **Goose/Kiro 驱动运行失败 (ENOENT)**: 如果启动 `goose` 或 `kiro` 代理失败并提示 `ENOENT` 错误，请先检查您的本机上是否分别安装了原生的 Goose CLI 或 Kiro CLI (`goose` 或 `kiro-cli`）。两款工具均为原生编译二进制包，**均没有**对应的 npm 安装包。
