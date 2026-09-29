import type { ConnectionEvent } from "./interface.js";

export type PtyStream = "stdout" | "stderr";

export interface PtyParserContext {
  readonly sessionId: string;
  readonly cwd: string;
}

export interface PtyTurnResult {
  readonly stopReason: "end_turn" | "cancelled" | "error";
  readonly exitCode?: number;
  readonly signal?: number;
  readonly error?: string;
}

export interface PtyParserResult {
  readonly events?: ConnectionEvent[];
  readonly done?: boolean;
  readonly result?: PtyTurnResult;
}

export interface PtyOutputParser {
  readonly id: string;
  onTurnStart?(context: PtyParserContext, prompt: string): ConnectionEvent[];
  onData(context: PtyParserContext, stream: PtyStream, chunk: string): PtyParserResult;
  onExit?(context: PtyParserContext, exitCode: number, signal?: number): PtyParserResult;
  onCancel?(context: PtyParserContext): PtyParserResult;
}

export function createAgentMessageEvent(context: PtyParserContext, text: string): ConnectionEvent {
  return {
    type: "agent_message_chunk",
    payload: {
      sessionId: context.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
      content: { type: "text", text },
    },
  };
}

export function createStderrEvent(text: string): ConnectionEvent {
  return {
    type: "stderr",
    payload: text,
  };
}

export function createToolCallEvent(
  context: PtyParserContext,
  toolCallId: string,
  title: string,
  rawInput: Record<string, unknown>
): ConnectionEvent {
  return {
    type: "tool_call",
    payload: {
      sessionId: context.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title,
        kind: "edit",
        status: "pending",
        rawInput,
      },
    },
  };
}

export function createToolCallUpdateEvent(
  context: PtyParserContext,
  toolCallId: string,
  status: "pending" | "completed" | "failed",
  rawOutput: Record<string, unknown>
): ConnectionEvent {
  return {
    type: "tool_call_update",
    payload: {
      sessionId: context.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        kind: "edit",
        status,
        rawOutput,
      },
    },
  };
}
