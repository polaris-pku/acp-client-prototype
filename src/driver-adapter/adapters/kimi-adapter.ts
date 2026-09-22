import { BaseAdapter } from "../base-adapter.js";

export class KimiAdapter extends BaseAdapter {
  constructor() {
    super(
      "kimi",
      "Kimi Code",
      "Moonshot Kimi AI coding agent",
      "acp",
      "npx",
      ["-y", "@moonshot-ai/kimi-code", "acp"],
      "auto",
      {
        MOONSHOT_API_KEY: "terminal", // Fallback mapping if they support API keys
      }
    );
    // 该包不在本仓库依赖里，正常情况下解析不到，会按预期退回 npx。
    this.localLaunch = { packageName: "@moonshot-ai/kimi-code", args: ["acp"] };
  }
}
