import { strict as assert } from "node:assert";
import path from "node:path";
import { test } from "node:test";
import { ADAPTER_REGISTRY } from "../src/driver-adapter/registry.js";
import { invalidateProbe, probeAgent, probeAgents } from "../src/driver-adapter/probe.js";
import { pinnedLaunch } from "../src/driver-adapter/local-launch.js";

/**
 * 全量扫描会真的拉起本机全部 agent（npx 通道的那条还要走网络），
 * 单次约 12 秒且在离线环境会退化。要跑它们设 PROBE_FULL=1。
 */
const skipUnlessFull = { skip: process.env.PROBE_FULL !== "1" };

test("probe result matches what connect would spawn", async (t) => {
  // 覆盖两条通道：local-entry（claude）与 path（goose）。
  // 锁住这条是因为 kiro 曾经只在 resolveCommand 上做回退，探测与建连会拿到不同命令。
  for (const agentId of ["claude", "goose"]) {
    const adapter = ADAPTER_REGISTRY.getAdapter(agentId);
    const probe = await probeAgent(agentId, { force: true });
    if (!probe) {
      t.diagnostic(`${agentId} 本机不可用，跳过`);
      continue;
    }

    assert.equal(probe.provenance, adapter!.resolveLaunch().provenance);
    assert.deepEqual(
      adapter!.resolveCommand(),
      probe.launch,
      `${agentId} 建连拿到的命令与探测结果不一致`
    );
    assert.deepEqual(pinnedLaunch(agentId)?.launch, probe.launch);
  }
});

test("path-sourced launches are resolved to an absolute command", skipUnlessFull, async () => {
  // kiro 曾因为把已经是绝对路径的命令再交给 `where` 解析，被判成不可用。
  const probes = await probeAgents({ force: true, concurrency: 4 });
  const pathProbes = probes.filter((probe) => probe.provenance === "path");

  assert.ok(pathProbes.length > 0, "本机应至少有一个 path 通道的 agent");
  for (const probe of pathProbes) {
    assert.ok(
      path.isAbsolute(probe.launch.command),
      `${probe.agentId} 的 path 命令不是绝对路径：${probe.launch.command}`
    );
  }
});

test("probe caches its conclusion and force re-probes", async (t) => {
  const first = await probeAgent("claude", { force: true });
  if (!first) return t.diagnostic("claude 本机不可用，跳过");

  const cached = await probeAgent("claude");
  assert.equal(cached?.probedAt, first.probedAt, "缓存命中应返回同一份结论");

  const refreshed = await probeAgent("claude", { force: true });
  assert.notEqual(refreshed?.probedAt, first.probedAt, "force 应重新探测");
});

test("invalidateProbe drops the cached conclusion", async (t) => {
  const first = await probeAgent("claude", { force: true });
  if (!first) return t.diagnostic("claude 本机不可用，跳过");

  invalidateProbe("claude");
  const second = await probeAgent("claude");
  assert.notEqual(second?.probedAt, first.probedAt);
});

test("an aborted signal yields no probe", async () => {
  invalidateProbe();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await probeAgent("claude", { signal: controller.signal }), null);
});

test("mid-flight abort resolves to null", async () => {
  invalidateProbe();
  const controller = new AbortController();
  const pending = probeAgent("gemini", { signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  assert.equal(await pending, null);
});

test("the in-process mock driver is not probeable", async () => {
  assert.equal(await probeAgent("mock-driver"), null);
});

test("probeAgents excludes mock and keeps registry order", skipUnlessFull, async () => {
  const all = await probeAgents({ force: true, concurrency: 4 });
  const ids = all.map((probe) => probe.agentId);

  assert.ok(!ids.includes("mock-driver"), "probeAgents 不应包含 mock-driver");

  const registryOrder = ADAPTER_REGISTRY.listAdapters()
    .map((adapter) => adapter.agentId)
    .filter((id) => ids.includes(id));

  assert.deepEqual(ids, registryOrder);
});

test("protocol extension metadata is not reported as a capability", async (t) => {
  const probe = await probeAgent("claude", { force: true });
  if (!probe) return t.diagnostic("claude 本机不可用，跳过");

  const capabilities = probe.initialize?.agentCapabilities ?? [];
  assert.ok(
    !capabilities.some((name) => name.startsWith("_")),
    `能力列表混入了协议元数据：${capabilities.join(", ")}`
  );
});

test("unknown agentId throws", async () => {
  await assert.rejects(() => probeAgent("no-such-agent"), /Unknown agentId/);
});
