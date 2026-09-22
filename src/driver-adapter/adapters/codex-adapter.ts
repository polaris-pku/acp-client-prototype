import { BaseAdapter } from "../base-adapter.js";

export class CodexAdapter extends BaseAdapter {
  constructor() {
    super(
      "codex",
      "Codex CLI",
      "OpenAI Codex AI coding agent",
      "acp",
      "npx",
      ["-y", "@zed-industries/codex-acp"],
      "auto",
      {
        CODEX_API_KEY: "codex-api-key",
        OPENAI_API_KEY: "openai-api-key",
      }
    );
    this.localLaunch = { packageName: "@zed-industries/codex-acp", args: [] };
  }
}
