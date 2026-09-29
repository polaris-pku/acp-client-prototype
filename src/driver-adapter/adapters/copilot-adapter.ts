import { BaseAdapter } from "../base-adapter.js";

export class CopilotAdapter extends BaseAdapter {
  constructor() {
    super(
      "copilot",
      "GitHub Copilot CLI",
      "GitHub Copilot AI coding agent",
      "acp",
      "npx",
      ["-y", "@github/copilot", "--acp"],
      "none",
      {
        COPILOT_GITHUB_TOKEN: "copilot-github-token",
        GH_TOKEN: "gh-token",
        GITHUB_TOKEN: "github-token",
      }
    );
    this.localLaunch = { packageName: "@github/copilot", args: ["--acp"] };
  }
}
