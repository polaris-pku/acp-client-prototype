import dotenv from "dotenv";
dotenv.config();

import test from "node:test";
import assert from "node:assert/strict";
import { AcpClientBuilder, ClientMethodHandler } from "../src/index.js";

const TEST_TIMEOUT_MS = 120_000;

class CallSuccessHandler implements ClientMethodHandler {
  private resolveCalled?: (params: any) => void;

  readonly called = new Promise<any>((resolve) => {
    this.resolveCalled = resolve;
  });

  async handle(method: string, params: any): Promise<any> {
    if (method !== "call_success") {
      throw new Error(`Unsupported method: ${method}`);
    }

    const result = {
      ok: true,
      message: "call_success handler executed",
    };
    this.resolveCalled?.(params);
    return result;
  }
}

function getAgentId(): string {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("-") && !arg.endsWith(".js"));
  return process.env.EXTENSION_TEST_AGENT || args[0] || "mock-driver";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`call_success was not invoked within ${ms}ms`)), ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

async function waitForCallBeforeTurnEnd<T>(callPromise: Promise<T>, turnResult: Promise<any>) {
  const outcome = await Promise.race([
    callPromise.then((params) => ({ type: "called" as const, params })),
    turnResult.then(
      (result) => ({ type: "turn-ended" as const, result }),
      (err) => ({ type: "turn-failed" as const, err })
    ),
  ]);

  if (outcome.type === "called") return outcome.params;
  if (outcome.type === "turn-failed") throw outcome.err;

  throw new Error(
    `call_success was not invoked before the turn ended. Stop reason: ${
      outcome.result?.stopReason || "unknown"
    }`
  );
}

test("agent can call configured extension method through MCP tools", async () => {
  const agentId = getAgentId();

  const handler = new CallSuccessHandler();
  const token = `extension-${Date.now()}`;
  const client = new AcpClientBuilder()
    .withAgent(agentId)
    .withVerbose(process.env.VERBOSE === "1")
    .withAutoApprove(true)
    .withSandboxDir(process.cwd())
    .withExtensionConfig("tests/fixtures/call-success.extensions.yaml")
    .registerExtensionHandler("call_success", handler)
    .build();

  try {
    await client.initialize();
    await client.authenticate();
    await client.createSession(process.cwd());

    const prompt = [
      "Use the available tool named call_success now.",
      `Call it exactly once with token="${token}".`,
      "Do not finish until the tool call has completed.",
    ].join(" ");

    const turn = await client.sendPrompt(prompt);
    const calledParams = await withTimeout(
      waitForCallBeforeTurnEnd(handler.called, turn.result),
      TEST_TIMEOUT_MS
    );
    assert.equal(calledParams?.token, token);
  } finally {
    await client.shutdown();
  }
});
