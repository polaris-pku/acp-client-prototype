import { BaseAdapter } from "../base-adapter.js";

export class CodebuddyAdapter extends BaseAdapter {
  constructor() {
    super(
      "codebuddy",
      "CodeBuddy Code",
      "Tencent CodeBuddy AI coding agent",
      "acp",
      "npx",
      ["-y", "--package", "@tencent-ai/codebuddy-code", "codebuddy", "--acp"],
      "auto",
      {
        CODEBUDDY_API_KEY: "codebuddy-api-key",
        TENCENT_API_KEY: "tencent-api-key",
      }
    );
    // 该包声明了 codebuddy / cbc / cbc-prewarm 三个 bin，必须指名。
    this.localLaunch = {
      packageName: "@tencent-ai/codebuddy-code",
      binName: "codebuddy",
      args: ["--acp"],
    };
  }
}
