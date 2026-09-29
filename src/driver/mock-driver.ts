import { SCHEMA_VERSION, createId, nowTimestamp, type ArtifactRef } from "../core/types.js";
import type {
  DriverCapabilities,
  DriverPrompt,
  DriverRunResult,
  DriverRuntimeHandle,
  DriverRunStatus,
} from "./interface.js";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import http from "node:http";
import { Readable, Writable } from "node:stream";
import type { McpServerConfig } from "../core/types.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface MockSession {
  sessionId: string;
  mcpServers: McpServerConfig[];
}

interface SseMcpServerConfig {
  name: string;
  type: "sse";
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export class MockDriver implements DriverRuntimeHandle {
  readonly driver_id = "mock-driver";
  readonly session_id = "mock-session";
  readonly capabilities: DriverCapabilities = {
    supports_acp_extension: false,
    supports_structured_output: true,
    supports_session_load: false,
    supports_tool_events: true,
    supports_permission_events: false,
  };

  private initialized = false;

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    if (!this.initialized) {
      throw new Error("Driver not initialized. Please call initialize() first.");
    }

    const created_at = nowTimestamp();

    // Determine success/failed status from prompt
    const isSuccess = !input.prompt.toLowerCase().includes("driver_fail");
    const status: DriverRunStatus = isSuccess ? "succeeded" : "failed";

    const patchArtifact: ArtifactRef = {
      artifact_id: createId("artifact"),
      type: "patch",
      uri: `artifact://patch/${input.task_id}/mock-driver.patch`,
      sha256: "mock-sha256",
      producer_id: this.driver_id,
      task_id: input.task_id,
      metadata: {
        prompt_length: input.prompt.length,
        context_pack_id: input.context_pack_ref?.context_pack_id,
      },
      content: {
        kind: "text",
        content_ref: `data:text/plain,${encodeURIComponent(`MockDriver completed task ${input.task_id}\n`)}`,
        target_path: "generated/mock-driver-output.txt",
        media_type: "text/plain",
      },
      created_at,
      schema_version: SCHEMA_VERSION,
    };

    const transcript = await this.collectTranscript(input.task_id);

    return {
      driver_run_result_id: createId("driver_result"),
      session_id: this.session_id,
      status,
      response: isSuccess ? `MockDriver completed task ${input.task_id}.` : "MockDriver failed.",
      artifacts: [patchArtifact],
      transcript_ref: transcript,
      tool_events: [
        {
          tool_event_id: createId("tool_event"),
          tool_name: "mock.write_patch",
          status: "completed",
          summary: "MockDriver produced a deterministic patch artifact.",
          created_at,
          schema_version: SCHEMA_VERSION,
        },
      ],
      diagnostics: {
        driver_id: this.driver_id,
        duration_ms: 1,
        notes: [
          "Mock implementation wrapper for Direction A.",
          "Mock implementation; no real ACP or PTY session was started.",
        ],
      },
      ...(isSuccess
        ? {}
        : {
            error: {
              code: "COMPILATION_ERROR",
              message: "Simulated driver compilation failure.",
              retryable: true,
            },
          }),
      created_at,
      schema_version: SCHEMA_VERSION,
    };
  }

  async interrupt(_reason: string): Promise<void> {
    return Promise.resolve();
  }

  async collectTranscript(taskId = "task"): Promise<ArtifactRef> {
    const created_at = nowTimestamp();
    return {
      artifact_id: createId("artifact"),
      type: "transcript",
      uri: `artifact://transcript/${taskId}/mock-session`,
      producer_id: this.driver_id,
      task_id: taskId,
      created_at,
      schema_version: SCHEMA_VERSION,
    };
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }
}

function extractQuotedValue(text: string, key: string): string | undefined {
  const match = text.match(new RegExp(`${key}="([^"]+)"`));
  return match?.[1];
}

function isTerminalLifecyclePrompt(text: string): boolean {
  return (
    text.includes("TERMINAL_TEST_DONE") &&
    text.includes("terminal lifecycle check") &&
    extractQuotedValue(text, "token") !== undefined &&
    extractQuotedValue(text, "killToken") !== undefined
  );
}

function isSseMcpServer(server: McpServerConfig): server is SseMcpServerConfig {
  return "type" in server && server.type === "sse";
}

function terminalShortCommand(token: string) {
  return {
    command: process.execPath,
    args: ["-e", `console.log(${JSON.stringify(token)});`],
  };
}

function terminalLongRunningCommand(killToken: string) {
  return {
    command: process.execPath,
    args: ["-e", `console.log(${JSON.stringify(killToken)}); setTimeout(() => {}, 30000);`],
  };
}

function parseSseEvent(chunk: string): { event?: string; data?: string } {
  const event: { event?: string; data?: string } = {};
  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith("event:")) event.event = line.slice("event:".length).trim();
    if (line.startsWith("data:")) event.data = line.slice("data:".length).trim();
  }
  return event;
}

function waitForSseMessage(
  response: NodeJS.ReadableStream,
  predicate: (event: { event?: string; data?: string }) => boolean
): Promise<{ event?: string; data?: string }> {
  return new Promise((resolve) => {
    let buffer = "";
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();

      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex >= 0) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const event = parseSseEvent(rawEvent);
        if (predicate(event)) {
          response.off("data", onData);
          resolve(event);
          return;
        }
        separatorIndex = buffer.indexOf("\n\n");
      }
    };

    response.on("data", onData);
  });
}

function postJson(url: URL, request: JsonRpcRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(request);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function openSse(url: URL): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => resolve(res));
    req.on("error", reject);
  });
}

async function sendMcpRequest(
  sseResponse: http.IncomingMessage,
  messageUrl: URL,
  request: JsonRpcRequest
): Promise<JsonRpcResponse> {
  const responsePromise = waitForSseMessage(
    sseResponse,
    (event) => event.event === "message" && !!event.data
  );

  await postJson(messageUrl, request);

  const responseEvent = await responsePromise;
  return JSON.parse(responseEvent.data || "{}") as JsonRpcResponse;
}

async function callSseMcpTool(
  server: SseMcpServerConfig,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const sseUrl = new URL(server.url);
  const sseResponse = await openSse(sseUrl);

  try {
    const endpointEvent = await waitForSseMessage(
      sseResponse,
      (event) => event.event === "endpoint" && !!event.data
    );
    const messageUrl = new URL(endpointEvent.data || "", sseUrl);

    await sendMcpRequest(sseResponse, messageUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mock-driver-acp", version: "1.0.0" },
      },
    });

    const listResponse = await sendMcpRequest(sseResponse, messageUrl, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    if (listResponse.error) throw new Error(listResponse.error.message);

    const tools = listResponse.result?.tools || [];
    if (!tools.some((tool: any) => tool.name === toolName)) {
      throw new Error(`MCP tool not found: ${toolName}`);
    }

    const callResponse = await sendMcpRequest(sseResponse, messageUrl, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    });

    if (callResponse.error) throw new Error(callResponse.error.message);
    return callResponse.result;
  } finally {
    sseResponse.destroy();
  }
}

async function expectTerminalOutputRejected(terminal: any): Promise<void> {
  try {
    await terminal.currentOutput();
  } catch {
    return;
  }
  throw new Error("terminal/output succeeded after terminal/release");
}

async function runTerminalWorkflow(
  conn: any,
  sessionId: string,
  token: string,
  killToken: string
): Promise<void> {
  const short = terminalShortCommand(token);
  const terminal = await conn.createTerminal({
    sessionId,
    command: short.command,
    args: short.args,
    cwd: process.cwd(),
    outputByteLimit: 4096,
  });

  try {
    await terminal.waitForExit();
    await terminal.currentOutput();
  } finally {
    await terminal.release();
  }
  await expectTerminalOutputRejected(terminal);

  const longRunning = terminalLongRunningCommand(killToken);
  const killTerminal = await conn.createTerminal({
    sessionId,
    command: longRunning.command,
    args: longRunning.args,
    cwd: process.cwd(),
    outputByteLimit: 4096,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await killTerminal.currentOutput();
    await killTerminal.kill();
    await killTerminal.waitForExit();
    await killTerminal.currentOutput();
  } finally {
    await killTerminal.release();
  }
  await expectTerminalOutputRejected(killTerminal);
}

export function runAcpMockServer() {
  const writable = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const readable = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(writable, readable);

  let loadedSessionId: string | undefined;

  new AgentSideConnection((conn) => {
    const sessions = new Map<string, MockSession>();

    return {
      initialize: async () => {
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            supports_acp_extension: false,
            supports_structured_output: true,
            supports_session_load: false,
            supports_tool_events: true,
            supports_permission_events: false,
            mcpCapabilities: {
              sse: true,
              http: false,
            },
          },
          agentInfo: {
            name: "mock-driver-acp",
            version: "1.0.0",
          },
          authMethods: [],
        };
      },
      authenticate: async () => {
        return {};
      },
      newSession: async (params: any) => {
        loadedSessionId = undefined;
        const sessionId = "mock-session-id";
        sessions.set(sessionId, {
          sessionId,
          mcpServers: params.mcpServers || [],
        });
        return {
          sessionId,
        };
      },
      loadSession: async (params: any) => {
        loadedSessionId = params.sessionId;
        const sessionId = params.sessionId;
        if (!sessions.has(sessionId)) {
          sessions.set(sessionId, {
            sessionId,
            mcpServers: params.mcpServers || [],
          });
        }
        return {};
      },
      prompt: async (params: any) => {
        const promptText = params.prompt[0]?.text || "";

        try {
          if (isTerminalLifecyclePrompt(promptText)) {
            const token = extractQuotedValue(promptText, "token");
            const killToken = extractQuotedValue(promptText, "killToken");
            if (!token) throw new Error("terminal workflow prompt did not include token");
            if (!killToken) throw new Error("terminal workflow prompt did not include killToken");

            await conn.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "mock-terminal-workflow",
                title: "ACP terminal workflow test",
                kind: "execute",
                status: "in_progress",
              },
            });

            await runTerminalWorkflow(conn, params.sessionId, token, killToken);

            await conn.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "mock-terminal-workflow",
                status: "completed",
              },
            });

            await conn.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: "TERMINAL_TEST_DONE",
                },
              },
            });

            return {
              stopReason: "done",
            };
          } else if (promptText.includes("call_success")) {
            const session = sessions.get(params.sessionId);
            const sseServer = session?.mcpServers.find(isSseMcpServer);
            if (!sseServer) throw new Error("No SSE MCP server configured for call_success");

            const token = extractQuotedValue(promptText, "token");
            if (!token) throw new Error("call_success prompt did not include token");

            await conn.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "mock-call-success",
                title: "call_success",
                kind: "other",
                status: "pending",
                rawInput: { token },
              },
            });

            const result = await callSseMcpTool(sseServer, "call_success", { token });

            await conn.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "mock-call-success",
                status: "completed",
                rawOutput: result,
              },
            });

            return {
              stopReason: "done",
            };
          } else if (promptText.toLowerCase().includes("continue session")) {
            await conn.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: `Continued ${loadedSessionId || "no loaded session"}.`,
                },
              },
            });
            await conn.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "mock-session-write",
                title: "Update generated session file",
                kind: "edit",
                status: "in_progress",
                locations: [{ path: "generated/session.txt" }],
              },
            });
            await conn.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "mock-session-write",
                status: "completed",
                content: [
                  {
                    type: "diff",
                    path: "generated/session.txt",
                    oldText: "",
                    newText: `continued=${loadedSessionId || "none"}\n`,
                  },
                ],
              },
            });
          } else if (promptText.toLowerCase().includes("write")) {
            const filePath = ".temp/test-write.txt";
            const content = "Filesystem write verification token: XYZ123";

            await conn.writeTextFile({
              sessionId: params.sessionId,
              path: filePath,
              content: content,
            });

            return {
              stopReason: "done",
            };
          } else if (promptText.toLowerCase().includes("read")) {
            const filePath = ".temp/test-read.txt";
            const result = await conn.readTextFile({
              sessionId: params.sessionId,
              path: filePath,
            });

            await conn.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: result.content || "",
                },
              },
            });

            return {
              stopReason: "done",
            };
          }
        } catch (err: any) {
          const isTerminalTest = promptText.includes("TERMINAL_TEST_DONE");
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: isTerminalTest
                  ? `TERMINAL_TEST_FAIL ${err.message || String(err)}`
                  : `ERROR:${err.message || String(err)}`,
              },
            },
          });
        }

        if (
          !promptText.toLowerCase().includes("read") &&
          !promptText.toLowerCase().includes("continue session")
        ) {
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Mock driver completed the prompt." },
            },
          });
        }

        return {
          stopReason: "done",
          // 覆盖 PromptResponse.usage 的透传路径。thoughtTokens 故意不给，
          // 用来验证可选项缺席时不会补零。
          usage: {
            totalTokens: 30,
            inputTokens: 20,
            outputTokens: 10,
            cachedReadTokens: 5,
          },
        };
      },
      cancel: async () => {
        // ignore
      },
    };
  }, stream);
}

// Run ACP Mock Server if executed directly
if (
  typeof process !== "undefined" &&
  (process.argv[1]?.endsWith("mock-driver.js") ||
    process.argv[1]?.endsWith("mock-driver.ts") ||
    process.argv.includes("--acp") ||
    process.env.RUN_MOCK_DRIVER === "1")
) {
  runAcpMockServer();
}
