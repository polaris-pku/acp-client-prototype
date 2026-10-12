# Driver Probe 契约

探测本机可用的 ACP driver，输出一份可序列化的结果，供上层做列表展示与建连准备。

---

## 调用面

```ts
/** 探测全部候选，只返回可用的。不可用的不出现在结果里。 */
export function probeAgents(opts?: ProbeOptions): Promise<AgentProbe[]>;

/** 探测单个。探不到返回 null，不抛异常；只有未知 agentId 抛。 */
export function probeAgent(agentId: AgentId, opts?: ProbeOptions): Promise<AgentProbe | null>;

export interface ProbeOptions {
  /** 单次探测的总预算，含 spawn 与 initialize。默认 5000。 */
  timeoutMs?: number;
  /** 取消。已启动的子进程被终止，该 agent 的结论记为不可用。 */
  signal?: AbortSignal;
  /** 忽略缓存重新探测，并从通道重新解析命令。 */
  force?: boolean;
}

export interface ProbeAllOptions extends ProbeOptions {
  /** 同时探测的 agent 数。默认 3。结果顺序与并发度无关，恒为注册表顺序。 */
  concurrency?: number;
}
```

探测范围是 adapter 注册表里除 `mock-driver` 之外的全部 agent。mock 跑在进程内，没有可 spawn 的命令，「本机是否装了它」对它不成立。

## 输出面

```ts
interface AgentProbe {
  /** 稳定标识。与 adapter 注册表的 agentId、{AGENT_ID}_CLI_COMMAND 环境变量的前缀同一个词汇。 */
  agentId: AgentId;

  /** 展示名，直接来自 adapter。UI 不需要自己维护映射表。 */
  displayName: string;

  /** 可执行入口。探测成功后按 agentId 钉住，建连直接复用，不再自行解析。 */
  launch: ResolvedLaunch;

  /** 这条命令是哪条通道解析出来的。用于解释「为什么用的是它」，也用于排查环境差异。 */
  provenance: Provenance;

  /** 链路类型。acp 走 JSON-RPC，pty 走终端流。上层据此决定如何渲染输出。 */
  connectionType: "acp" | "pty";

  /**
   * 可用性的判据。
   * acp 类型为 initialize 的响应摘要；pty 类型为 undefined——它没有握手，
   * 可用性由「进程能起来且不立即退出」证明。
   */
  initialize?: InitializeEvidence;

  /** 该结论的产生时间（ISO 8601）。缓存命中时是原探测时间，不是当前时间。 */
  probedAt: string;
}

interface ResolvedLaunch {
  /** 可直接 spawn 的命令。PATH 通道下是完整绝对路径；local-entry 下是 node 的绝对路径。 */
  command: string;
  /** 不含命令自身的参数，与 command 拼接即完整命令行。 */
  args: string[];
}

interface InitializeEvidence {
  /** initialize 响应里回报的 ACP 协议版本。与客户端请求的版本不一致时，由 agent 侧决定接受或拒绝。 */
  protocolVersion: number;

  /** 该 agent 接受的认证方式数量。只给数量，不传凭据或凭据标识符。为 0 表示无需认证。 */
  authMethods: number;

  /** agent 声明的能力标志位名称。缺失表示该 agent 未声明能力。 */
  agentCapabilities?: string[];

  /** agent 自报的版本号，用于排查「同一个 agent 不同版本行为不同」。 */
  agentVersion?: string;
}

type Provenance =
  /** {AGENT_ID}_CLI_COMMAND 显式指定。用户手工配置，优先级最高。 */
  | "env-override"
  /** 从本包依赖树解析到已安装包的 bin 入口。热缓存，无 npx 解析开销。 */
  | "local-entry"
  /** 系统 PATH 中找到可执行文件。goose、kiro、aider 这类走这条。 */
  | "path"
  /** 本机没有，只能靠 npx 按需拉起：首次会下载包，每次启动多付约 1.4 秒解析开销。 */
  | "npx-on-demand";
```

## 边界

- 候选范围是本仓库 adapter 注册表里的 agent，探针只做本机判定。
- **可用 = spawn 起来并跑完 `initialize`。** 文件存在不算，起来了但不认 ACP 也不算。`pty` 类型的判据是进程能起来且不立即退出。
- `initialize` 返回即结束，不建会话、不认证。没有 API key 不影响判定。
- 解析按序短路：`env-override` → `local-entry` → `path`，都没命中则 `npx-on-demand`。四条通道只产出候选命令，`initialize` 通过才进结果。
- 探测跑通的命令按 agentId 钉住，建连时优先于重新解析，两边发同一条命令。
- **结果缓存 10 分钟**（失败结论 60 秒）。同一 agent 的并发探测合并为一次，不会重复拉起进程。
- `signal` 取消或超时后，子进程整棵被终止（Windows 上 `taskkill /T`），不留孤儿。
- `force` 会同时丢弃缓存与钉住的命令，从通道重新解析。

## 实现约束

- `local-entry` 的解析范围是本包自己的依赖树（`requireFromHere`），不含全局安装的包。
- `path` 通道用系统的 `where` / `which` 解析成绝对路径后写入结果；解析不到即判为不可用，不退化成裸命令名。
- `agentCapabilities` 只收 initialize 响应里的顶层键，`_meta` 这类协议元数据槽不算能力。

## 探测示例

本机实跑 `probeAgent()`（Windows 11，pnpm 安装，git-bash）的返回，六个 agent 覆盖四种 `provenance` 与两种 `connectionType`：

```jsonc
[
  {
    "agentId": "claude",
    "displayName": "Claude Code",
    // 入口是 JS 脚本，用 node 的绝对路径执行（Windows 不支持 shebang）
    "launch": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\dddam\\Documents\\GitHub\\acp-client-prototype\\node_modules\\.pnpm\\@agentclientprotocol+claude_4bed4f58dd5f413fee469ccc782a7ab6\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js",
        "acp",
      ],
    },
    "provenance": "local-entry",
    "connectionType": "acp",
    "initialize": {
      "protocolVersion": 1,
      // 该 agent 未在 initialize 阶段声明认证方式
      "authMethods": 0,
      "agentCapabilities": [
        "loadSession",
        "mcpCapabilities",
        "promptCapabilities",
        "sessionCapabilities",
      ],
      "agentVersion": "0.39.0",
    },
    "probedAt": "2026-10-12T05:38:45.744Z",
  },
  {
    "agentId": "gemini",
    "displayName": "Gemini CLI",
    "launch": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\dddam\\Documents\\GitHub\\acp-client-prototype\\node_modules\\.pnpm\\@google+gemini-cli@0.44.1\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js",
        "--acp",
      ],
    },
    "provenance": "local-entry",
    "connectionType": "acp",
    "initialize": {
      "protocolVersion": 1,
      // 4 种认证方式，凭据不在探测阶段提供
      "authMethods": 4,
      "agentCapabilities": ["loadSession", "mcpCapabilities", "promptCapabilities"],
      "agentVersion": "0.44.1",
    },
    "probedAt": "2026-10-12T05:38:48.580Z",
  },
  {
    "agentId": "goose",
    "displayName": "Goose",
    // PATH 通道：本机安装的原生二进制，直接执行，不经 node
    "launch": {
      "command": "C:\\Users\\dddam\\.local\\bin\\goose.exe",
      "args": ["acp"],
    },
    "provenance": "path",
    "connectionType": "acp",
    "initialize": {
      "protocolVersion": 1,
      "authMethods": 1,
      "agentCapabilities": [
        "auth",
        "loadSession",
        "mcpCapabilities",
        "promptCapabilities",
        "sessionCapabilities",
      ],
      "agentVersion": "1.39.0",
    },
    "probedAt": "2026-10-12T05:38:49.703Z",
  },
  {
    "agentId": "kiro",
    "displayName": "Kiro AI",
    // adapter 的 LOCALAPPDATA 回退解析出的绝对路径
    "launch": {
      "command": "C:\\Users\\dddam\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe",
      "args": ["acp"],
    },
    "provenance": "path",
    "connectionType": "acp",
    "initialize": {
      "protocolVersion": 1,
      "authMethods": 1,
      "agentCapabilities": [
        "auth",
        "loadSession",
        "mcpCapabilities",
        "promptCapabilities",
        "sessionCapabilities",
      ],
      "agentVersion": "2.10.0",
    },
    "probedAt": "2026-10-12T05:38:50.708Z",
  },
  {
    "agentId": "aider",
    "displayName": "Aider",
    // PATH 通道解析出的绝对路径
    "launch": {
      "command": "C:\\Users\\dddam\\.local\\bin\\aider.exe",
      "args": ["--no-pretty", "--no", "--m"],
    },
    "provenance": "path",
    "connectionType": "pty",
    // 没有 initialize：pty 的可用性由「进程能起来且不立即退出」证明
    "probedAt": "2026-10-12T05:38:52.961Z",
  },
  {
    "agentId": "kimi",
    "displayName": "Kimi Code",
    // 本机没有，靠 npx 按需拉起（首次会下载包）
    "launch": {
      "command": "npx",
      "args": ["-y", "@moonshot-ai/kimi-code", "acp"],
    },
    "provenance": "npx-on-demand",
    "connectionType": "acp",
    "initialize": {
      "protocolVersion": 1,
      "authMethods": 1,
      "agentCapabilities": [
        "auth",
        "loadSession",
        "mcpCapabilities",
        "promptCapabilities",
        "sessionCapabilities",
      ],
      "agentVersion": "2.1.1",
    },
    "probedAt": "2026-10-12T05:38:56.384Z",
  },
]
```

本次实跑的耗时不属于契约字段，列出仅供参照：goose 1038 ms、kiro 1085 ms、aider 1214 ms（pty 观察窗口 1200 ms）、claude 1298 ms、gemini 2936 ms、kimi 3693 ms。

本次实跑的耗时不属于契约字段，列出仅供参照：kiro 1015 ms、goose 1050 ms、claude 1189 ms、aider 2206 ms（pty 观察窗口 1200 ms）、gemini 2935 ms、kimi 3511 ms。

值得注意：`local-entry` 不保证快——gemini 比 PATH 上的 goose 慢近 3 倍，它的入口是几 MB 的 bundle，`local-entry` 省掉的是 npx 解析，省不掉 agent 自身启动。
