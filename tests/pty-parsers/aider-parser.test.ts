import test from "node:test";
import assert from "node:assert/strict";
import {
  AiderPtyParser,
  parseAiderEditBlocks,
} from "../../src/connection/pty-parsers/aider-parser.js";
import type { PtyParserContext } from "../../src/connection/pty-parser.js";

const context: PtyParserContext = {
  sessionId: "session-aider",
  cwd: process.cwd(),
};

test("Aider parser extracts whole-file edit blocks", () => {
  const output = [
    "src/example.ts",
    "```ts",
    "export function answer() {",
    "  return 42;",
    "}",
    "```",
  ].join("\n");

  const edits = parseAiderEditBlocks(output);

  assert.equal(edits.length, 1);
  assert.equal(edits[0]?.format, "whole");
  assert.equal(edits[0]?.path, "src/example.ts");
  assert.match(edits[0]?.newText ?? "", /return 42/);
});

test("Aider parser extracts SEARCH/REPLACE diff blocks", () => {
  const output = [
    "src/example.ts",
    "```",
    "<<<<<<< SEARCH",
    "return 1;",
    "=======",
    "return 2;",
    ">>>>>>> REPLACE",
    "```",
  ].join("\n");

  const edits = parseAiderEditBlocks(output);

  assert.equal(edits.length, 1);
  assert.equal(edits[0]?.format, "diff");
  assert.equal(edits[0]?.path, "src/example.ts");
  assert.equal(edits[0]?.oldText, "return 1;");
  assert.equal(edits[0]?.newText, "return 2;");
});

test("Aider parser extracts fenced unified diffs", () => {
  const output = [
    "```diff",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@",
    "-return 1;",
    "+return 2;",
    "```",
  ].join("\n");

  const edits = parseAiderEditBlocks(output);

  assert.equal(edits.length, 1);
  assert.equal(edits[0]?.format, "udiff");
  assert.equal(edits[0]?.path, "src/example.ts");
  assert.equal(edits[0]?.oldText, "return 1;");
  assert.equal(edits[0]?.newText, "return 2;");
});

test("Aider parser emits message and tool-call events for newly detected edits", () => {
  const parser = new AiderPtyParser();
  const output = [
    "src/example.ts",
    "```",
    "<<<<<<< SEARCH",
    "old",
    "=======",
    "new",
    ">>>>>>> REPLACE",
    "```",
  ].join("\n");

  const first = parser.onData(context, "stdout", output);
  const second = parser.onData(context, "stdout", output);

  assert.equal(first.events?.[0]?.type, "agent_message_chunk");
  assert.equal(first.events?.[1]?.type, "tool_call");
  assert.equal(first.events?.[1]?.payload.update.toolCallId, "aider-edit-1");
  assert.equal(first.events?.[1]?.payload.update.rawInput.path, "src/example.ts");
  assert.equal(first.events?.[2]?.type, "tool_call_update");
  assert.equal(first.events?.[2]?.payload.update.rawOutput.oldText, "old");
  assert.equal(first.events?.[2]?.payload.update.rawOutput.newText, "new");

  assert.equal(second.events?.length, 1);
  assert.equal(second.events?.[0]?.type, "agent_message_chunk");
});

test("Aider parser completes the turn on process exit", () => {
  const parser = new AiderPtyParser();

  const result = parser.onExit(context, 0);

  assert.equal(result.done, true);
  assert.equal(result.result?.stopReason, "end_turn");
  assert.equal(result.result?.exitCode, 0);
});
