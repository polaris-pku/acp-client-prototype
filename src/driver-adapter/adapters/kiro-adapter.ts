import { existsSync } from "node:fs";
import path from "node:path";
import { BaseAdapter } from "../base-adapter.js";
import type { LaunchCommand, LaunchProvenance } from "../interface.js";

export class KiroAdapter extends BaseAdapter {
  constructor() {
    super(
      "kiro",
      "Kiro AI",
      "AWS Kiro AI coding agent CLI",
      "acp",
      "kiro-cli",
      ["acp"],
      "pre-configured"
    );
  }

  override resolveLaunch(): { launch: LaunchCommand; provenance: LaunchProvenance } {
    const resolved = super.resolveLaunch();

    // On Windows, if kiro-cli isn't in Node's current PATH
    // we attempt to resolve its standard absolute installation path.
    if (resolved.launch.command === "kiro-cli") {
      const localAppData =
        process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
      const fallbackPath = path.join(localAppData, "Kiro-Cli", "kiro-cli.exe");
      if (existsSync(fallbackPath)) {
        return {
          launch: { command: fallbackPath, args: resolved.launch.args },
          provenance: resolved.provenance,
        };
      }
    }

    return resolved;
  }
}
