import test from "node:test";
import assert from "node:assert/strict";
import { DefaultPtyParser } from "../../src/connection/pty-parsers/default-parser.js";
import type { PtyParserContext } from "../../src/connection/pty-parser.js";

const context: PtyParserContext = {
  sessionId: "session-1",
  cwd: process.cwd(),
};

test("default PTY parser forwards stdout as agent message chunks", () => {
  const parser = new DefaultPtyParser();

  const result = parser.onData(context, "stdout", "hello from pty");

  assert.equal(result.done, undefined);
  assert.equal(result.events?.length, 1);
  assert.equal(result.events?.[0]?.type, "agent_message_chunk");
  assert.equal(result.events?.[0]?.payload.sessionId, "session-1");
  assert.equal(result.events?.[0]?.payload.update.sessionUpdate, "agent_message_chunk");
  assert.equal(result.events?.[0]?.payload.update.content.text, "hello from pty");
});

test("default PTY parser forwards stderr separately", () => {
  const parser = new DefaultPtyParser();

  const result = parser.onData(context, "stderr", "warning");

  assert.equal(result.events?.length, 1);
  assert.equal(result.events?.[0]?.type, "stderr");
  assert.equal(result.events?.[0]?.payload, "warning");
});

test("default PTY parser completes the turn when the PTY process exits", () => {
  const parser = new DefaultPtyParser();

  const success = parser.onExit(context, 0);
  const failure = parser.onExit(context, 2);

  assert.equal(success.done, true);
  assert.equal(success.result?.stopReason, "end_turn");
  assert.equal(success.result?.exitCode, 0);

  assert.equal(failure.done, true);
  assert.equal(failure.result?.stopReason, "error");
  assert.equal(failure.result?.exitCode, 2);
});
