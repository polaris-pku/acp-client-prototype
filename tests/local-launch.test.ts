import { strict as assert } from "node:assert";
import path from "node:path";
import { test } from "node:test";
import { BaseAdapter } from "../src/driver-adapter/base-adapter.js";
import { resolveLocalLaunch, type LocalLaunchSpec } from "../src/driver-adapter/local-launch.js";

/** 允许注入任意 spec，以便在不改动真实 adapter 的前提下测回退路径。 */
class StubAdapter extends BaseAdapter {
  constructor(localLaunch?: LocalLaunchSpec) {
    super("stub", "Stub", "Stub adapter", "acp", "npx", ["-y", "stub-package"], "none");
    this.localLaunch = localLaunch;
  }
}

const CLAUDE_PACKAGE = "@agentclientprotocol/claude-agent-acp";

test("resolves an installed package to an absolute entry point run by node", () => {
  const resolved = resolveLocalLaunch({ packageName: CLAUDE_PACKAGE, args: ["acp"] });

  assert.ok(resolved, `${CLAUDE_PACKAGE} 是本仓库依赖，应当可解析`);
  assert.equal(resolved.command, process.execPath);
  assert.ok(
    path.isAbsolute(resolved.args[0]),
    "入口必须是绝对路径：agent 的 cwd 是任务工作区，不是本仓库"
  );
  assert.match(resolved.args[0], /claude-agent-acp/);
  assert.equal(resolved.args.at(-1), "acp");
});

test("returns undefined for a package that is not installed", () => {
  assert.equal(
    resolveLocalLaunch({ packageName: "acp-client-prototype-no-such-package", args: [] }),
    undefined
  );
});

test("refuses to guess between several bins, and resolves once one is named", () => {
  // codebuddy 同时声明 codebuddy / cbc / cbc-prewarm 三个 bin。
  assert.equal(
    resolveLocalLaunch({ packageName: "@tencent-ai/codebuddy-code", args: ["--acp"] }),
    undefined,
    "多个 bin 且未指名时必须放弃解析，而不是按键序猜一个"
  );

  const named = resolveLocalLaunch({
    packageName: "@tencent-ai/codebuddy-code",
    binName: "codebuddy",
    args: ["--acp"],
  });
  assert.ok(named);
  assert.equal(named.command, process.execPath);
  assert.match(named.args[0], /bin[\\/]codebuddy$/);
});

test("executes a native binary entry directly instead of wrapping it in node", () => {
  const resolved = resolveLocalLaunch({ packageName: "opencode-ai", args: ["acp"] });

  assert.ok(resolved);
  // opencode 的入口是 .exe，用 node 包一层会直接失败。
  assert.notEqual(resolved.command, process.execPath);
  assert.match(resolved.command, /opencode\.exe$/i);
  assert.deepEqual(resolved.args, ["acp"]);
});

test("falls back to the npx command when the package cannot be resolved", () => {
  const adapter = new StubAdapter({
    packageName: "acp-client-prototype-no-such-package",
    args: [],
  });

  assert.deepEqual(adapter.resolveCommand(), {
    command: "npx",
    args: ["-y", "stub-package"],
  });
});

test("uses the local entry instead of npx when the package resolves", () => {
  const adapter = new StubAdapter({ packageName: CLAUDE_PACKAGE, args: ["acp"] });
  const { command, args } = adapter.resolveCommand();

  assert.equal(command, process.execPath);
  assert.match(args[0], /claude-agent-acp/);
});

test("keeps an explicit CLI override ahead of local resolution", () => {
  const adapter = new StubAdapter({ packageName: CLAUDE_PACKAGE, args: ["acp"] });
  const envKey = "STUB_CLI_COMMAND";
  const argsKey = "STUB_CLI_ARGS";
  const original = { command: process.env[envKey], args: process.env[argsKey] };

  try {
    process.env[envKey] = "/custom/agent";
    delete process.env[argsKey];
    assert.deepEqual(adapter.resolveCommand(), {
      command: "/custom/agent",
      args: ["-y", "stub-package"],
    });

    process.env[argsKey] = "--flag one";
    assert.deepEqual(adapter.resolveCommand(), {
      command: "/custom/agent",
      args: ["--flag", "one"],
    });
  } finally {
    for (const [key, value] of [
      [envKey, original.command],
      [argsKey, original.args],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("adapters that never used npx keep their original command", () => {
  // goose / kiro / aider 本来就走原生二进制或 PTY，不该被这次改动影响。
  const adapter = new StubAdapter(undefined);
  assert.deepEqual(adapter.resolveCommand(), {
    command: "npx",
    args: ["-y", "stub-package"],
  });
});
