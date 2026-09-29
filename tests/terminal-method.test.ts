import dotenv from "dotenv";
dotenv.config();

import test from "node:test";
import assert from "node:assert/strict";
import { AcpClientBuilder, TerminalHandler, type ClientMethodHandler } from "../src/index.js";

const TEST_TIMEOUT_MS = 120_000;

interface TerminalAuditEntry {
  method: string;
  params: any;
  succeeded: boolean;
  result?: any;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

class AuditedTerminalHandler implements ClientMethodHandler {
  constructor(
    private readonly inner: ClientMethodHandler,
    private readonly audit: TerminalAuditEntry[]
  ) {}

  async handle(method: string, params: any): Promise<any> {
    const entry: TerminalAuditEntry = {
      method,
      params: cloneAuditValue(params),
      succeeded: false,
      startedAt: Date.now(),
    };
    this.audit.push(entry);

    try {
      const result = await this.inner.handle(method, params);
      entry.succeeded = true;
      entry.result = cloneAuditValue(result);
      return result;
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      entry.finishedAt = Date.now();
    }
  }
}

function cloneAuditValue(value: any): any {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function getAgentId(): string {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("-") && !arg.endsWith(".js"));
  return process.env.TERMINAL_TEST_AGENT || args[0] || "mock-driver";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`terminal test did not finish within ${ms}ms`)), ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function findAuditEntry(
  audit: TerminalAuditEntry[],
  method: string,
  predicate: (entry: TerminalAuditEntry, index: number) => boolean,
  message: string
): TerminalAuditEntry {
  const entry = audit.find(
    (candidate, index) => candidate.method === method && predicate(candidate, index)
  );
  if (!entry) {
    assert.fail(`${message}\nAudit log:\n${JSON.stringify(audit, null, 2)}`);
  }
  return entry;
}

function assertReleaseInvalidatedTerminal(
  audit: TerminalAuditEntry[],
  terminalId: string,
  releaseIndex: number
): void {
  const rejectedOutput = findAuditEntry(
    audit,
    "terminal/output",
    (entry, index) =>
      index > releaseIndex &&
      entry.params?.terminalId === terminalId &&
      !entry.succeeded &&
      /not found|released|invalid/i.test(entry.error || ""),
    `terminal/output after release should be rejected for ${terminalId}`
  );

  assert.equal(rejectedOutput.succeeded, false);
}

function assertTerminalWorkflowAudit(
  audit: TerminalAuditEntry[],
  token: string,
  killToken: string
): void {
  const shortOutput = findAuditEntry(
    audit,
    "terminal/output",
    (entry) =>
      entry.succeeded &&
      typeof entry.result?.output === "string" &&
      entry.result.output.includes(token) &&
      entry.result.exitStatus?.exitCode === 0,
    "terminal/output should capture the short command output and exit status"
  );
  const shortTerminalId = shortOutput.params?.terminalId;
  assert.equal(typeof shortTerminalId, "string");

  findAuditEntry(
    audit,
    "terminal/create",
    (entry) => entry.succeeded && entry.result?.terminalId === shortTerminalId,
    "terminal/create should create the short command terminal"
  );

  const shortWait = findAuditEntry(
    audit,
    "terminal/wait_for_exit",
    (entry, index) =>
      index < audit.indexOf(shortOutput) &&
      entry.succeeded &&
      entry.params?.terminalId === shortTerminalId &&
      entry.result?.exitCode === 0 &&
      (entry.result?.signal ?? null) === null,
    "terminal/wait_for_exit should observe the short command exiting cleanly"
  );

  assert.equal(shortOutput.result.truncated, false);
  assert.ok(audit.indexOf(shortWait) < audit.indexOf(shortOutput));

  const shortRelease = findAuditEntry(
    audit,
    "terminal/release",
    (entry, index) =>
      index > audit.indexOf(shortOutput) &&
      entry.succeeded &&
      entry.params?.terminalId === shortTerminalId,
    "terminal/release should release the short command terminal"
  );
  assertReleaseInvalidatedTerminal(audit, shortTerminalId, audit.indexOf(shortRelease));

  const killOutputBefore = findAuditEntry(
    audit,
    "terminal/output",
    (entry) =>
      entry.succeeded &&
      typeof entry.result?.output === "string" &&
      entry.result.output.includes(killToken),
    "terminal/output should capture the long-running command output before kill"
  );
  const killTerminalId = killOutputBefore.params?.terminalId;
  assert.equal(typeof killTerminalId, "string");
  assert.notEqual(killTerminalId, shortTerminalId);

  findAuditEntry(
    audit,
    "terminal/create",
    (entry) => entry.succeeded && entry.result?.terminalId === killTerminalId,
    "terminal/create should create the long-running terminal"
  );

  const killCall = findAuditEntry(
    audit,
    "terminal/kill",
    (entry, index) =>
      index > audit.indexOf(killOutputBefore) &&
      entry.succeeded &&
      entry.params?.terminalId === killTerminalId,
    "terminal/kill should terminate the long-running terminal after output was read"
  );

  findAuditEntry(
    audit,
    "terminal/wait_for_exit",
    (entry, index) =>
      index > audit.indexOf(killCall) &&
      entry.succeeded &&
      entry.params?.terminalId === killTerminalId &&
      (entry.result?.exitCode !== 0 || Boolean(entry.result?.signal)),
    "terminal/wait_for_exit should observe a non-clean exit after terminal/kill"
  );

  const killOutputAfter = findAuditEntry(
    audit,
    "terminal/output",
    (entry, index) =>
      index > audit.indexOf(killCall) &&
      entry.succeeded &&
      entry.params?.terminalId === killTerminalId &&
      typeof entry.result?.output === "string" &&
      entry.result.output.includes(killToken),
    "terminal/output after kill should keep the captured output available"
  );

  const killRelease = findAuditEntry(
    audit,
    "terminal/release",
    (entry, index) =>
      index > audit.indexOf(killOutputAfter) &&
      entry.succeeded &&
      entry.params?.terminalId === killTerminalId,
    "terminal/release should release the killed terminal"
  );
  assertReleaseInvalidatedTerminal(audit, killTerminalId, audit.indexOf(killRelease));
}

test("agent can exercise ACP terminal methods through a real terminal workflow", async () => {
  const agentId = getAgentId();
  const terminalAudit: TerminalAuditEntry[] = [];
  const client = new AcpClientBuilder()
    .withAgent(agentId)
    .withVerbose(process.env.VERBOSE === "1")
    .withAutoApprove(true)
    .withSandboxDir(process.cwd())
    .withTerminalHandler(new AuditedTerminalHandler(new TerminalHandler(), terminalAudit))
    .build();

  let responseText = "";
  client.on("agent_message_chunk", (payload) => {
    responseText += payload.update?.content?.text || "";
  });

  try {
    await client.initialize();
    await client.authenticate();
    await client.createSession(process.cwd());

    const token = `terminal-short-${Date.now()}`;
    const killToken = `terminal-kill-${Date.now()}`;
    const prompt = [
      "Perform a terminal lifecycle check.",
      "Do not inspect repository files, source files, tests, or package metadata.",
      "Do not write or run helper scripts. Do not import, instantiate, or call TerminalHandler directly.",
      "If you cannot run terminal commands in this session, reply exactly TERMINAL_TEST_UNAVAILABLE.",
      `Use token="${token}" for the short command output and killToken="${killToken}" for the long-running command output.`,
      "Step 1: run a short command that prints the token and exits with code 0.",
      "Step 2: wait for the short command to exit.",
      "Step 3: inspect and record the short command output, truncated flag, and exit status.",
      "Step 4: clean up the short command terminal.",
      "Step 5: start a long-running command that prints the killToken and remains alive.",
      "Step 6: inspect and record the long-running command output before terminating it.",
      "Step 7: terminate the long-running command, wait for it to exit, then inspect its final output.",
      "Step 8: clean up the long-running command terminal.",
      "When the workflow is complete, reply with TERMINAL_TEST_DONE. If any operation fails, reply with TERMINAL_TEST_FAIL and the reason.",
    ].join(" ");

    const turn = await client.sendPrompt(prompt);
    await withTimeout(turn.result, TEST_TIMEOUT_MS);

    assert.doesNotMatch(responseText, /TERMINAL_TEST_UNAVAILABLE/);
    assert.doesNotMatch(responseText, /TERMINAL_TEST_FAIL/);
    assertTerminalWorkflowAudit(terminalAudit, token, killToken);
  } finally {
    await client.shutdown();
  }
});
