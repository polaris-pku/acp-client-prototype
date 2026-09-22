import { BaseAdapter } from "../base-adapter.js";

export class ClaudeAdapter extends BaseAdapter {
  constructor() {
    super(
      "claude",
      "Claude Code",
      "Anthropic Claude AI coding agent",
      "acp",
      "npx",
      ["-y", "@agentclientprotocol/claude-agent-acp", "acp"],
      "auto",
      {
        ANTHROPIC_API_KEY: "anthropic-api-key",
      }
    );
    this.localLaunch = { packageName: "@agentclientprotocol/claude-agent-acp", args: ["acp"] };
  }
}
