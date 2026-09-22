import { BaseAdapter } from "../base-adapter.js";

export class OpencodeAdapter extends BaseAdapter {
  constructor() {
    super(
      "opencode",
      "OpenCode AI",
      "OpenCode open-source AI coding agent",
      "acp",
      "npx",
      ["-y", "opencode-ai", "acp"],
      "pre-configured",
      {
        OPENCODE_CONFIG: "opencode-config",
      }
    );
    this.localLaunch = { packageName: "opencode-ai", args: ["acp"] };
  }
}
