#!/usr/bin/env node
import dotenv from "dotenv";
dotenv.config();

import { isAbsolute, relative, resolve, sep } from "node:path";
import { AcpClientBuilder } from "../client/builder.js";
import {
  SCHEMA_VERSION,
  createId,
  nowTimestamp,
  type ArtifactRef,
  type McpServerConfig,
} from "../core/types.js";
import type { ConnectionEvent, TurnController } from "../connection/interface.js";
import type {
  DriverPrompt,
  DriverRunResult,
  DriverRunStatus,
  DriverToolEvent,
} from "./interface.js";

const DRIVER_EVENT_PREFIX = "NEWIDE_DRIVER_EVENT ";
const DRIVER_EVENT_SCHEMA_VERSION = "driver-event.v1";

/**
 * `driver.phase` 事件携带的段名闭集。
 *
 * 这是**跨仓库契约**：newide-scaffold 的 CommandDriverTransport 按这些名字开/闭
 * `driver.<phase>` 的耗时埋点。改这里的字面量等于改契约，两边必须同时改。
 *
 * 只登记驱动调用内部、从外部观测不到的段。spawn、首个输出、以及进程退出
 * （cleanup）发生在 ACP 进程之外或之后，由 transport 侧自行计时，不在此重复；
 * prompt / turn 已由既有的 driver.turn_started / turn_completed 覆盖。
 */
type DriverPhase = "initialize" | "authenticate" | "session" | "shutdown";

interface RunOptions {
  agentId: string;
  workspace: string;
}

interface ResultBuildInput {
  input?: DriverPrompt;
  agentId: string;
  workspace: string;
  sessionId?: string;
  startedAtMs: number;
  events: ConnectionEvent[];
  promptResult?: unknown;
  error?: unknown;
  cancelRequested?: boolean;
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw.trim();
}

function parseDriverPrompt(raw: string): DriverPrompt {
  if (!raw) {
    throw new Error("DriverPrompt JSON is required on stdin.");
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("DriverPrompt must be a JSON object.");
  }

  for (const field of ["task_id", "run_id", "prompt"] as const) {
    if (typeof parsed[field] !== "string" || parsed[field].length === 0) {
      throw new Error(`DriverPrompt.${field} must be a non-empty string.`);
    }
  }

  for (const field of ["session_id", "workspace_path"] as const) {
    if (
      parsed[field] !== undefined &&
      (typeof parsed[field] !== "string" || parsed[field].length === 0)
    ) {
      throw new Error(`DriverPrompt.${field} must be a non-empty string when provided.`);
    }
  }

  if (parsed.context_pack_ref !== undefined && !isRecord(parsed.context_pack_ref)) {
    throw new Error("DriverPrompt.context_pack_ref must be an object when provided.");
  }

  if (parsed.mcp_servers !== undefined && !Array.isArray(parsed.mcp_servers)) {
    throw new Error("DriverPrompt.mcp_servers must be an array when provided.");
  }

  return {
    task_id: parsed.task_id as string,
    run_id: parsed.run_id as string,
    prompt: parsed.prompt as string,
    session_id: parsed.session_id as string | undefined,
    workspace_path: parsed.workspace_path as string | undefined,
    mcp_servers: Array.isArray(parsed.mcp_servers)
      ? (parsed.mcp_servers as McpServerConfig[])
      : undefined,
    context_pack_ref: parsed.context_pack_ref as DriverPrompt["context_pack_ref"],
    created_at: typeof parsed.created_at === "string" ? parsed.created_at : nowTimestamp(),
    schema_version:
      typeof parsed.schema_version === "string" ? parsed.schema_version : SCHEMA_VERSION,
  };
}

async function runContractPrompt(
  input: DriverPrompt,
  options: RunOptions
): Promise<DriverRunResult> {
  const startedAtMs = Date.now();
  const workspace = resolve(input.workspace_path || options.workspace);
  const events: ConnectionEvent[] = [];
  let sessionId: string | undefined;
  let client: ReturnType<AcpClientBuilder["build"]> | undefined;
  let cancelRequested = false;
  let eventSequence = 0;
  let onTerminate: (() => void) | undefined;

  const emitDriverEvent = (eventType: string, payload: unknown): void => {
    const envelope = {
      schema_version: DRIVER_EVENT_SCHEMA_VERSION,
      event_type: eventType,
      task_id: input.task_id,
      run_id: input.run_id,
      ...(sessionId ? { session_id: sessionId } : {}),
      sequence: ++eventSequence,
      created_at: nowTimestamp(),
      payload,
    };
    try {
      process.stderr.write(`${DRIVER_EVENT_PREFIX}${JSON.stringify(envelope)}\n`);
    } catch {
      // The audit channel is best-effort and must not change driver behavior.
    }
  };

  /**
   * 包住一个冷启动阶段，成对发 driver.phase 的 started / completed。
   *
   * 失败也发 completed（带 `ok: false` 与错误摘要），而不是另发一条 failed：
   * transport 侧关闭埋点的逻辑因此无条件、无分支；而且「这一段花了多久才失败」
   * 本身正是失败归因需要的数据。
   *
   * 固定字段写在 `...meta` 之后，保证 meta 覆盖不掉 phase / boundary / ok。
   */
  const runPhase = async <T>(
    phase: DriverPhase,
    meta: Record<string, unknown>,
    run: () => Promise<T>
  ): Promise<T> => {
    emitDriverEvent("driver.phase", { ...meta, phase, boundary: "started" });
    try {
      const value = await run();
      emitDriverEvent("driver.phase", { ...meta, phase, boundary: "completed", ok: true });
      return value;
    } catch (error) {
      emitDriverEvent("driver.phase", {
        ...meta,
        phase,
        boundary: "completed",
        ok: false,
        error: errorMessage(error),
      });
      throw error;
    }
  };

  try {
    // 先落到 const：闭包里要用到收窄后的类型，而外层 `client` 只留给 finally 收尾。
    const acpClient = new AcpClientBuilder()
      .withAgent(options.agentId)
      .withVerbose(false)
      .withAutoApprove(process.env.AUTO_APPROVE === "1")
      .withSandboxDir(workspace)
      .build();
    client = acpClient;

    await runPhase("initialize", {}, () => acpClient.initialize());
    await runPhase("authenticate", {}, () => acpClient.authenticate());

    const mcpServers = input.mcp_servers ?? [];

    // create 与 load 的成本形态不同（load 要重放历史），而是否复用会话正是本次
    // 归因要回答的问题之一，所以用 meta.mode 而不是拆成两个段名。
    const sessionMode = input.session_id ? "load" : "create";
    const session = await runPhase("session", { mode: sessionMode }, () =>
      input.session_id
        ? acpClient.loadSession(input.session_id, workspace, mcpServers)
        : acpClient.createSession(workspace, mcpServers)
    );
    sessionId = session.sessionId;
    emitDriverEvent("driver.turn_started", { prompt_length: input.prompt.length });

    // ── Signal handling: capture signals that arrive during sendPrompt ──
    let pendingCancel = false;
    const earlySignalHandler = () => {
      pendingCancel = true;
    };
    process.once("SIGTERM", earlySignalHandler);
    process.once("SIGINT", earlySignalHandler);

    const turn = await client.sendPrompt(input.prompt);

    // Clean up early handlers (no-op if already fired via once)
    process.removeListener("SIGTERM", earlySignalHandler);
    process.removeListener("SIGINT", earlySignalHandler);

    if (pendingCancel) {
      // Signal arrived during sendPrompt — cancel immediately
      cancelRequested = true;
      emitDriverEvent("driver.turn_cancel_requested", { reason: "process_signal" });
      void turn.cancel().catch((cancelError) => {
        emitDriverEvent("driver.turn_cancel_failed", { error: errorMessage(cancelError) });
      });
    } else {
      // Register handlers for signals during turn execution
      onTerminate = (): void => {
        cancelRequested = true;
        emitDriverEvent("driver.turn_cancel_requested", { reason: "process_signal" });
        void turn.cancel().catch((cancelError) => {
          emitDriverEvent("driver.turn_cancel_failed", { error: errorMessage(cancelError) });
        });
      };
      process.once("SIGTERM", onTerminate);
      process.once("SIGINT", onTerminate);
    }

    const collectEvents = collectTurnEvents(turn, events, (event) => {
      emitDriverEvent(event.type, event.payload);
    }).catch((eventError) => {
      events.push({
        type: "stderr",
        payload: `event collection failed: ${errorMessage(eventError)}`,
      });
      emitDriverEvent("driver.event_collection_failed", { error: errorMessage(eventError) });
    });
    const promptResult = await turn.result;
    await collectEvents;
    emitDriverEvent("driver.turn_completed", {
      stop_reason: stopReasonFrom(promptResult) || null,
    });

    return buildRunResult({
      input,
      agentId: options.agentId,
      workspace,
      sessionId,
      startedAtMs,
      events,
      promptResult,
      cancelRequested,
    });
  } catch (error) {
    emitDriverEvent("driver.turn_failed", { error: errorMessage(error) });
    return buildRunResult({
      input,
      agentId: options.agentId,
      workspace,
      sessionId,
      startedAtMs,
      events,
      error,
      cancelRequested,
    });
  } finally {
    if (onTerminate) {
      process.removeListener("SIGTERM", onTerminate);
      process.removeListener("SIGINT", onTerminate);
    }
    const closing = client;
    if (closing) {
      try {
        await runPhase("shutdown", {}, () => closing.shutdown());
      } catch (shutdownError) {
        process.stderr.write(`[driver:run] shutdown failed: ${errorMessage(shutdownError)}\n`);
      }
    }
  }
}

async function collectTurnEvents(
  turn: TurnController,
  events: ConnectionEvent[],
  onEvent?: (event: ConnectionEvent) => void
): Promise<void> {
  for await (const event of turn) {
    events.push(event);
    onEvent?.(event);
  }
}

function buildRunResult(params: ResultBuildInput): DriverRunResult {
  const createdAt = nowTimestamp();
  const schemaVersion = params.input?.schema_version || SCHEMA_VERSION;
  const taskId = params.input?.task_id || "unknown-task";
  const sessionId = params.sessionId || "session-unavailable";
  const stopReason = stopReasonFrom(params.promptResult);
  const status = mapRunStatus(stopReason, params.error, params.cancelRequested);
  const error = buildDriverError(status, stopReason, params.error);
  const transcriptStats = summarizeTranscript(params.events);

  return {
    driver_run_result_id: createId("driver_result"),
    session_id: sessionId,
    status,
    response: collectAgentResponse(params.events),
    artifacts: collectArtifactRefs(
      params.events,
      params.agentId,
      taskId,
      params.workspace,
      createdAt,
      schemaVersion
    ),
    transcript_ref: {
      artifact_id: createId("artifact"),
      type: "transcript",
      uri: `artifact://transcript/${encodeURIComponent(taskId)}/${encodeURIComponent(sessionId)}`,
      producer_id: params.agentId,
      task_id: taskId,
      metadata: {
        workspace: params.workspace,
        event_count: params.events.length,
        agent_message_chars: transcriptStats.agentMessageChars,
        agent_thought_chars: transcriptStats.agentThoughtChars,
        stderr_chars: transcriptStats.stderrChars,
        stop_reason: stopReason || null,
      },
      created_at: createdAt,
      schema_version: schemaVersion,
    },
    tool_events: collectToolEvents(params.events, createdAt, schemaVersion),
    diagnostics: {
      driver_id: params.agentId,
      duration_ms: Math.max(0, Date.now() - params.startedAtMs),
      notes: buildDiagnosticNotes(params, stopReason),
    },
    ...(error ? { error } : {}),
    created_at: createdAt,
    schema_version: schemaVersion,
  };
}

function collectToolEvents(
  events: ConnectionEvent[],
  createdAt: string,
  schemaVersion: string
): DriverToolEvent[] {
  const byId = new Map<string, DriverToolEvent>();

  for (const event of events) {
    if (event.type === "tool_call") {
      const update = updateRecord(event);
      const id = stringValue(update.toolCallId) || createId("tool_event");
      byId.set(id, {
        tool_event_id: id,
        tool_name: stringValue(update.kind) || stringValue(update.title) || "tool_call",
        status: normalizeToolStatus(update.status),
        summary: stringValue(update.title) || "ACP tool call started.",
        created_at: createdAt,
        schema_version: schemaVersion,
      });
    }

    if (event.type === "tool_call_update") {
      const update = updateRecord(event);
      const id = stringValue(update.toolCallId) || createId("tool_event");
      const existing = byId.get(id);
      byId.set(id, {
        tool_event_id: id,
        tool_name: existing?.tool_name || "tool_call",
        status: normalizeToolStatus(update.status),
        summary: summarizeToolUpdate(update, existing),
        created_at: existing?.created_at || createdAt,
        schema_version: schemaVersion,
      });
    }

    if (event.type === "permission_request") {
      const payload = payloadRecord(event);
      const id = stringValue(payload.requestId) || createId("tool_event");
      byId.set(id, {
        tool_event_id: id,
        tool_name: "permission_request",
        status: "pending",
        summary: stringValue(payload.title) || "ACP permission request.",
        created_at: createdAt,
        schema_version: schemaVersion,
      });
    }
  }

  return [...byId.values()];
}

function collectArtifactRefs(
  events: ConnectionEvent[],
  agentId: string,
  taskId: string,
  workspace: string,
  createdAt: string,
  schemaVersion: string
): ArtifactRef[] {
  const artifacts: ArtifactRef[] = [];

  for (const event of events) {
    if (event.type !== "tool_call_update") continue;

    const content = updateRecord(event).content;
    if (!Array.isArray(content)) continue;

    for (const item of content) {
      if (!isRecord(item) || item.type !== "diff") continue;

      const diffPath = artifactTargetPath(workspace, stringValue(item.path));
      const newText = stringValue(item.newText);
      if (!diffPath || newText === undefined) continue;

      const artifactId = createId("artifact");
      artifacts.push({
        artifact_id: artifactId,
        type: "diff",
        uri: `artifact://diff/${encodeURIComponent(taskId)}/${encodeURIComponent(diffPath)}`,
        producer_id: agentId,
        task_id: taskId,
        metadata: {
          path: diffPath,
          tool_call_id: stringValue(updateRecord(event).toolCallId),
        },
        content: {
          kind: "text",
          content_ref: `data:text/plain;charset=utf-8,${encodeURIComponent(newText)}`,
          target_path: diffPath,
          media_type: "text/plain",
        },
        created_at: createdAt,
        schema_version: schemaVersion,
      });
    }
  }

  return artifacts;
}

function artifactTargetPath(workspace: string, candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  const absolute = resolve(workspace, candidate);
  const target = relative(workspace, absolute);
  if (target === "" || target === ".." || target.startsWith(`..${sep}`) || isAbsolute(target)) {
    return undefined;
  }
  return target;
}

function collectAgentResponse(events: ConnectionEvent[]): string {
  return events
    .filter((event) => event.type === "agent_message_chunk")
    .map((event) => textFromContent(updateRecord(event).content))
    .join("");
}

function buildDiagnosticNotes(params: ResultBuildInput, stopReason?: string): string[] {
  const notes = [
    `agent_id=${params.agentId}`,
    `workspace=${params.workspace}`,
    `event_count=${params.events.length}`,
  ];

  if (params.sessionId) notes.push(`session_id=${params.sessionId}`);
  if (stopReason) notes.push(`stop_reason=${stopReason}`);
  if (params.error) notes.push(`error=${errorMessage(params.error)}`);

  return notes;
}

function summarizeTranscript(events: ConnectionEvent[]): {
  agentMessageChars: number;
  agentThoughtChars: number;
  stderrChars: number;
} {
  let agentMessageChars = 0;
  let agentThoughtChars = 0;
  let stderrChars = 0;

  for (const event of events) {
    if (event.type === "agent_message_chunk") {
      agentMessageChars += textFromContent(updateRecord(event).content).length;
    }
    if (event.type === "agent_thought_chunk") {
      agentThoughtChars += textFromContent(updateRecord(event).content).length;
    }
    if (event.type === "stderr") {
      stderrChars += String(event.payload ?? "").length;
    }
  }

  return { agentMessageChars, agentThoughtChars, stderrChars };
}

function stopReasonFrom(promptResult: unknown): string | undefined {
  if (!isRecord(promptResult)) return undefined;
  return stringValue(promptResult.stopReason);
}

function mapRunStatus(
  stopReason: string | undefined,
  error: unknown,
  cancelRequested = false
): DriverRunStatus {
  if (cancelRequested) return "cancelled";
  if (error) return "failed";
  const normalized = (stopReason || "done").toLowerCase();
  if (normalized.includes("cancel")) return "cancelled";
  if (normalized.includes("interrupt")) return "interrupted";
  if (normalized.includes("error") || normalized.includes("fail")) return "failed";
  return "succeeded";
}

function buildDriverError(
  status: DriverRunStatus,
  stopReason: string | undefined,
  error: unknown
): DriverRunResult["error"] {
  if (status === "cancelled" || status === "interrupted") return undefined;
  if (error) {
    return {
      code: "DRIVER_RUNNER_ERROR",
      message: errorMessage(error),
      retryable: true,
    };
  }

  if (status === "failed") {
    return {
      code: "ACP_STOP_REASON",
      message: `ACP agent returned stop reason: ${stopReason || "unknown"}`,
      retryable: true,
    };
  }

  return undefined;
}

function normalizeToolStatus(value: unknown): DriverToolEvent["status"] {
  if (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "failed"
  ) {
    return value;
  }
  return "in_progress";
}

function summarizeToolUpdate(update: Record<string, unknown>, existing?: DriverToolEvent): string {
  const status = stringValue(update.status);
  if (status === "completed") return "ACP tool call completed.";
  if (status === "failed") return "ACP tool call failed.";
  return existing?.summary || "ACP tool call updated.";
}

function textFromContent(content: unknown): string {
  if (!isRecord(content)) return "";
  return stringValue(content.text) || "";
}

function updateRecord(event: ConnectionEvent): Record<string, unknown> {
  const payload = payloadRecord(event);
  return isRecord(payload.update) ? payload.update : {};
}

function payloadRecord(event: ConnectionEvent): Record<string, unknown> {
  return isRecord(event.payload) ? event.payload : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const agentId = process.env.ACP_AGENT_ID || "mock-driver";
  const workspace = resolve(process.env.ACP_WORKSPACE || process.cwd());
  const startedAtMs = Date.now();
  let input: DriverPrompt | undefined;

  try {
    input = parseDriverPrompt(await readStdin());
    const result = await runContractPrompt(input, { agentId, workspace });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.error?.code === "DRIVER_RUNNER_ERROR") {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`[driver:run] ${errorMessage(error)}\n`);
    const result = buildRunResult({
      input,
      agentId,
      workspace,
      startedAtMs,
      events: [],
      error,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`[driver:run] fatal: ${errorMessage(error)}\n`);
  process.exit(1);
});
