import { probeAgents, probeAgent, type AgentProbe } from "../src/driver-adapter/probe.js";
import { ADAPTER_REGISTRY } from "../src/driver-adapter/registry.js";

const TARGETS = (process.env.PROBE_TARGETS ?? "claude,gemini,goose,kiro,aider,kimi").split(",");

// 清掉环境变量覆盖，让本次探测反映真实的本机解析路径
for (const key of Object.keys(process.env)) {
  if (/_CLI_(COMMAND|ARGS)$/.test(key)) delete process.env[key];
}

function summarize(p: AgentProbe) {
  return {
    agentId: p.agentId,
    displayName: p.displayName,
    launch: p.launch,
    provenance: p.provenance,
    connectionType: p.connectionType,
    initialize: p.initialize,
    probedAt: p.probedAt,
  };
}

async function main() {
  const started = Date.now();
  console.log(
    `候选：${ADAPTER_REGISTRY.listAdapters()
      .map((a) => a.agentId)
      .join(", ")}`
  );
  console.log(`探测：${TARGETS.join(", ")}\n`);

  const found: AgentProbe[] = [];
  for (const id of TARGETS) {
    const t0 = Date.now();
    let probe: AgentProbe | null = null;
    try {
      probe = await probeAgent(id, { timeoutMs: 8000 });
    } catch (err) {
      console.log(`${id.padEnd(10)} 抛异常：${(err as Error).message}`);
      continue;
    }
    const ms = Date.now() - t0;
    if (probe) {
      found.push(probe);
      console.log(`${id.padEnd(10)} ✓ ${ms} ms  ${probe.provenance}  ${probe.connectionType}`);
    } else {
      console.log(`${id.padEnd(10)} ✗ ${ms} ms  不可用`);
    }
  }

  console.log(`\n合计 ${Date.now() - started} ms，可用 ${found.length}/${TARGETS.length}\n`);
  console.log("=== 探测结果 JSON ===");
  console.log(JSON.stringify(found.map(summarize), null, 2));

  // 顺带验一下 probeAgents 的全量路径
  const all = await probeAgents({ timeoutMs: 8000 });
  console.log(
    `\nprobeAgents() 全量扫描 → ${all.length} 个可用：${all.map((p) => p.agentId).join(", ")}`
  );
}

void main();
