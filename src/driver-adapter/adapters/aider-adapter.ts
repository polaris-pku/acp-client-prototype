import { BaseAdapter } from "../base-adapter.js";
import { AiderPtyParser } from "../../connection/pty-parsers/aider-parser.js";
import type { PtyOutputParser } from "../../connection/pty-parser.js";

export class AiderAdapter extends BaseAdapter {
  constructor() {
    super(
      "aider",
      "Aider",
      "AI coding assistant via PTY fallback",
      "pty",
      "aider",
      ["--no-pretty", "--no", "--m"],
      "pre-configured"
    );
  }

  override resolveEnv(): Record<string, string | undefined> {
    return {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    };
  }

  override createPtyParser(): PtyOutputParser {
    return new AiderPtyParser();
  }
}
