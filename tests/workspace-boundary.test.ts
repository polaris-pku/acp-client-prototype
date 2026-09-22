import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { FileSystemHandler } from "../src/client-methods/filesystem-handler.js";
import { TerminalHandler, createTerminalEnv } from "../src/client-methods/terminal-handler.js";

let root = "";
let workspace = "";
let sibling = "";

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "acp-workspace-boundary-"));
  workspace = path.join(root, "project");
  sibling = path.join(root, "project-secrets");
  await fs.mkdir(workspace);
  await fs.mkdir(sibling);
  // Use junction on Windows to avoid elevation requirement
  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(sibling, path.join(workspace, "escape-link"), symlinkType);
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("filesystem rejects sibling-prefix and symlink workspace escapes", async () => {
  const handler = new FileSystemHandler(workspace);

  await assert.rejects(
    handler.handle("fs/write_text_file", {
      path: path.join("..", path.basename(sibling), "outside.txt"),
      content: "blocked",
    }),
    /outside of workspace/
  );
  await assert.rejects(
    handler.handle("fs/write_text_file", {
      path: path.join("escape-link", "outside.txt"),
      content: "blocked",
    }),
    /outside of workspace/
  );
});

test("terminal rejects cwd outside workspace", async () => {
  const handler = new TerminalHandler({ workspace });

  await assert.rejects(
    handler.handle("terminal/create", { command: "pwd", cwd: sibling }),
    /outside of workspace/
  );
});

test("terminal environment excludes provider credentials", () => {
  const env = createTerminalEnv({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    ANTHROPIC_API_KEY: "secret",
    OPENAI_API_KEY: "secret",
    CODEX_API_KEY: "secret",
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/tmp/home");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
});

test("a missing workspace root surfaces at first use instead of crashing the caller", async () => {
  const missing = path.join(root, "does-not-exist");
  const handler = new FileSystemHandler(missing);

  // 回归：旧实现在构造函数里发起 realpath 并让拒绝悬空。调用方还没 await 它，
  // 进程级 unhandled rejection 就把整个驱动杀掉——stdout 一个字节都没有，
  // 一次本可归因的失败退化成无结构的崩溃。
  // 这里给悬空拒绝一个触发的机会：它若仍无人接管，这个测试进程会直接失败。
  await new Promise((resolve) => setTimeout(resolve, 25));

  // 改为在真正用到沙箱根时才浮出，并沿调用栈正常上抛为可归因的错误。
  // 用写路径而非读路径：写路径会先向上找到已存在的祖先目录，从而真正走到沙箱根。
  await assert.rejects(
    handler.handle("fs/write_text_file", { path: path.join("nested", "file.txt"), content: "x" }),
    /Resource not found/
  );
});
