import {
  createAgentMessageEvent,
  createStderrEvent,
  PtyOutputParser,
  PtyParserContext,
  PtyParserResult,
  PtyStream,
} from "../pty-parser.js";

export class DefaultPtyParser implements PtyOutputParser {
  readonly id = "default";

  onData(context: PtyParserContext, stream: PtyStream, chunk: string): PtyParserResult {
    if (stream === "stderr") {
      return { events: [createStderrEvent(chunk)] };
    }

    return { events: [createAgentMessageEvent(context, chunk)] };
  }

  onExit(_context: PtyParserContext, exitCode: number, signal?: number): PtyParserResult {
    return {
      done: true,
      result: {
        stopReason: exitCode === 0 ? "end_turn" : "error",
        exitCode,
        signal,
        error: exitCode === 0 ? undefined : `PTY process exited with code ${exitCode}`,
      },
    };
  }

  onCancel(_context: PtyParserContext): PtyParserResult {
    return {
      done: true,
      result: { stopReason: "cancelled" },
    };
  }
}
