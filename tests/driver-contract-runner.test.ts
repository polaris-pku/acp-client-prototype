import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

interface DriverEventEnvelope {
  event_type: string;
  sequence: number;
  payload?: Record<string, unknown>;
}

/** 解析保留审计通道上的 driver 事件；非事件行（诊断输出）被丢弃。 */
function readDriverEvents(stderr: string): DriverEventEnvelope[] {
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith("NEWIDE_DRIVER_EVENT "))
    .map((line) => JSON.parse(line.slice("NEWIDE_DRIVER_EVENT ".length)));
}

test("driver contract runner maps stdin DriverPrompt to stdout DriverRunResult JSON", () => {
  const prompt = {
    task_id: "task-contract-smoke",
    run_id: "run-contract-smoke",
    prompt: "Say hello from the driver contract smoke test.",
    created_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    schema_version: "v0",
  };

  const result = spawnSync("node", [join(process.cwd(), "dist/src/driver/contract-runner.js")], {
    cwd: process.cwd(),
    input: JSON.stringify(prompt),
    encoding: "utf8",
    env: {
      ...process.env,
      ACP_AGENT_ID: "mock-driver",
      ACP_WORKSPACE: process.cwd(),
      AUTO_APPROVE: "1",
      VERBOSE: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotThrow(() => JSON.parse(result.stdout));

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "succeeded");
  assert.equal(parsed.session_id, "mock-session-id");
  assert.equal(parsed.schema_version, "v0");
  assert.equal(parsed.diagnostics.driver_id, "mock-driver");
  assert.ok(parsed.driver_run_result_id);
  assert.ok(parsed.transcript_ref);
  assert.ok(Array.isArray(parsed.artifacts));
  assert.ok(Array.isArray(parsed.tool_events));
});
test("driver contract runner loads an existing session and returns response and artifact content", () => {
  const prompt = {
    task_id: "task-contract-session",
    run_id: "run-contract-session",
    session_id: "existing-session-id",
    workspace_path: process.cwd(),
    prompt: "Continue session and update the generated file.",
    created_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    schema_version: "v0",
  };

  const result = spawnSync("node", [join(process.cwd(), "dist/src/driver/contract-runner.js")], {
    cwd: process.cwd(),
    input: JSON.stringify(prompt),
    encoding: "utf8",
    env: {
      ...process.env,
      ACP_AGENT_ID: "mock-driver",
      ACP_WORKSPACE: process.cwd(),
      AUTO_APPROVE: "1",
      VERBOSE: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.session_id, "existing-session-id");
  assert.match(parsed.response, /continued existing-session-id/i);
  assert.equal(parsed.artifacts.length, 1);
  assert.equal(parsed.artifacts[0].content.kind, "text");
  assert.equal(parsed.artifacts[0].content.target_path, join("generated", "session.txt"));
  assert.match(parsed.artifacts[0].content.content_ref, /^data:text\/plain/);
});

test("driver contract runner emits ACP events on the reserved audit channel", () => {
  const prompt = {
    task_id: "task-contract-events",
    run_id: "run-contract-events",
    prompt: "Emit a streamed message before the final result.",
    created_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    schema_version: "v0",
  };

  const result = spawnSync("node", [join(process.cwd(), "dist/src/driver/contract-runner.js")], {
    cwd: process.cwd(),
    input: JSON.stringify(prompt),
    encoding: "utf8",
    env: {
      ...process.env,
      ACP_AGENT_ID: "mock-driver",
      ACP_WORKSPACE: process.cwd(),
      AUTO_APPROVE: "1",
      VERBOSE: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const eventLines = result.stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith("NEWIDE_DRIVER_EVENT "));
  assert.ok(eventLines.length > 0, result.stderr);
  const firstEvent = JSON.parse(eventLines[0].slice("NEWIDE_DRIVER_EVENT ".length));
  assert.equal(firstEvent.schema_version, "driver-event.v1");
  assert.equal(firstEvent.task_id, prompt.task_id);
  assert.equal(firstEvent.run_id, prompt.run_id);
  assert.ok(firstEvent.event_type);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
});

test("driver contract runner rejects non-array mcp_servers", () => {
  const prompt = {
    task_id: "task-contract-mcp-bad",
    run_id: "run-contract-mcp-bad",
    prompt: "Say hello.",
    mcp_servers: "not-an-array",
    created_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    schema_version: "v0",
  };

  const result = spawnSync("node", [join(process.cwd(), "dist/src/driver/contract-runner.js")], {
    cwd: process.cwd(),
    input: JSON.stringify(prompt),
    encoding: "utf8",
    env: {
      ...process.env,
      ACP_AGENT_ID: "mock-driver",
      ACP_WORKSPACE: process.cwd(),
      AUTO_APPROVE: "1",
      VERBOSE: "0",
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mcp_servers must be an array/i);
});

test("driver contract runner accepts valid mcp_servers array", () => {
  const prompt = {
    task_id: "task-contract-mcp-ok",
    run_id: "run-contract-mcp-ok",
    prompt: "Say hello.",
    mcp_servers: [
      { name: "test-server", command: "node", args: ["-e", "console.log(1)"], env: [] },
    ],
    created_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    schema_version: "v0",
  };

  const result = spawnSync("node", [join(process.cwd(), "dist/src/driver/contract-runner.js")], {
    cwd: process.cwd(),
    input: JSON.stringify(prompt),
    encoding: "utf8",
    env: {
      ...process.env,
      ACP_AGENT_ID: "mock-driver",
      ACP_WORKSPACE: process.cwd(),
      AUTO_APPROVE: "1",
      VERBOSE: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "succeeded");
});

test("driver contract runner marks each cold-start phase with a paired driver.phase event", () => {
  const prompt = {
    task_id: "task-contract-phases",
    run_id: "run-contract-phases",
    prompt: "Say hello from the phase mark test.",
    created_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    schema_version: "v0",
  };

  const result = spawnSync("node", [join(process.cwd(), "dist/src/driver/contract-runner.js")], {
    cwd: process.cwd(),
    input: JSON.stringify(prompt),
    encoding: "utf8",
    env: {
      ...process.env,
      ACP_AGENT_ID: "mock-driver",
      ACP_WORKSPACE: process.cwd(),
      AUTO_APPROVE: "1",
      VERBOSE: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const events = readDriverEvents(result.stderr);
  const phases = events.filter((event) => event.event_type === "driver.phase");

  // 成对且有序：每段先 started 后 completed。失败路径同样成对（completed + ok:false），
  // 所以这里能断言精确序列，而不必容忍缺项。
  assert.deepEqual(
    phases.map((event) => `${String(event.payload?.phase)}:${String(event.payload?.boundary)}`),
    [
      "initialize:started",
      "initialize:completed",
      "authenticate:started",
      "authenticate:completed",
      "session:started",
      "session:completed",
      "shutdown:started",
      "shutdown:completed",
    ]
  );
  assert.ok(
    phases.every((event) => event.payload?.boundary === "started" || event.payload?.ok === true),
    result.stderr
  );
  // sequence 是这条通道的全序，但分段之间夹着 turn 事件，所以只保证严格递增，
  // 不保证连续——用连续性去断言会误伤正确实现。
  const sequences = events.map((event) => event.sequence);
  assert.deepEqual(
    sequences,
    [...sequences].sort((left, right) => left - right),
    result.stderr
  );
  assert.equal(new Set(sequences).size, sequences.length, result.stderr);

  // 分段必须把 turn 夹在中间：transport 侧靠 session:completed 关闭握手埋点，
  // 靠 shutdown:started 起算关停埋点；顺序错了整条时间线就归错段。
  const timeline = events.map((event) =>
    event.event_type === "driver.phase"
      ? `phase:${String(event.payload?.phase)}:${String(event.payload?.boundary)}`
      : event.event_type
  );
  const turnStarted = timeline.indexOf("driver.turn_started");
  assert.ok(turnStarted > timeline.indexOf("phase:session:completed"), result.stderr);
  assert.ok(turnStarted < timeline.indexOf("phase:shutdown:started"), result.stderr);

  const sessionStarted = phases.find((event) => event.payload?.phase === "session");
  assert.equal(sessionStarted?.payload?.mode, "create");
});

test("driver contract runner pairs a failed phase with ok:false and still returns a result", () => {
  const prompt = {
    task_id: "task-contract-phase-failure",
    run_id: "run-contract-phase-failure",
    prompt: "This prompt must never reach the agent.",
    created_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    schema_version: "v0",
  };

  const result = spawnSync("node", [join(process.cwd(), "dist/src/driver/contract-runner.js")], {
    cwd: process.cwd(),
    input: JSON.stringify(prompt),
    encoding: "utf8",
    env: {
      ...process.env,
      ACP_AGENT_ID: "claude",
      // 用必然不存在的可执行文件替换 agent 命令行，确定性触发 initialize 失败。
      CLAUDE_CLI_COMMAND: join(process.cwd(), "dist", "__no_such_agent_binary__"),
      AUTO_APPROVE: "1",
      VERBOSE: "0",
    },
  });

  // 阶段失败不等于进程崩溃：失败同样要收束成一份可归因的 DriverRunResult，
  // 而不是让调用方只看到「退出码非零 + 空 stdout」。
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "failed");
  assert.ok(parsed.error);

  const phases = readDriverEvents(result.stderr).filter(
    (event) => event.event_type === "driver.phase"
  );
  // 失败要 fail-fast：initialize 挂掉后不再进 authenticate / session，只补一段收尾。
  assert.deepEqual(
    phases.map((event) => `${String(event.payload?.phase)}:${String(event.payload?.boundary)}`),
    ["initialize:started", "initialize:completed", "shutdown:started", "shutdown:completed"]
  );
  // 关键：失败的那一段成对收尾并带 ok:false，上层关闭埋点因此不需要分支。
  assert.equal(phases[1]?.payload?.ok, false, result.stderr);
  assert.ok(phases[1]?.payload?.error, result.stderr);
});

test("driver contract runner marks a resumed session as mode=load", () => {
  const prompt = {
    task_id: "task-contract-phase-load",
    run_id: "run-contract-phase-load",
    session_id: "existing-session-id",
    workspace_path: process.cwd(),
    prompt: "Continue session and report the phase mode.",
    created_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    schema_version: "v0",
  };

  const result = spawnSync("node", [join(process.cwd(), "dist/src/driver/contract-runner.js")], {
    cwd: process.cwd(),
    input: JSON.stringify(prompt),
    encoding: "utf8",
    env: {
      ...process.env,
      ACP_AGENT_ID: "mock-driver",
      ACP_WORKSPACE: process.cwd(),
      AUTO_APPROVE: "1",
      VERBOSE: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const sessionStarted = readDriverEvents(result.stderr).find(
    (event) => event.event_type === "driver.phase" && event.payload?.phase === "session"
  );
  assert.equal(sessionStarted?.payload?.mode, "load");
});
