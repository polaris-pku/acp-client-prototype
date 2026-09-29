import { ClientMethodHandler } from "./interface.js";
import { select } from "@inquirer/prompts";
import { PACKAGE_INDEX_FETCH_RE, SCRIPT_NETWORK_RE } from "../security/package-index-block.js";

const NETWORK_TOOL_RE = /\b(WebFetch|WebSearch|Browser|browser_navigate|browser_search)\b/i;
const NETWORK_BASH_RE =
  /\b(curl|wget|httpie|Invoke-WebRequest|iwr|Fetch|ssh|scp|sftp|nc|ncat|netcat|telnet)\b|\bgh\s+(api|pr|issue|browse|repo)\b|\bgit\s+(clone|fetch|pull|push|ls-remote|submodule)\b|https?:\/\//i;
const SHELL_TOOL_RE = /\b(Bash|Terminal|shell)\b/i;

function envFlagEnabled(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function deniedPathSubstrings(): string[] {
  const raw = process.env.ACP_DENY_PATH_SUBSTRINGS_JSON?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("expected a JSON array");
    }
    return parsed
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toLowerCase())
      .filter(Boolean);
  } catch (error) {
    throw new Error(
      `Invalid ACP_DENY_PATH_SUBSTRINGS_JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function toolLabel(params: any): string {
  return [
    params?.title,
    params?.toolCall?.title,
    params?.toolCall?.kind,
    params?.toolCall?.toolName,
    params?.tool_name,
    params?.message,
    params?.toolCall?.description,
  ]
    .filter((v) => typeof v === "string" && v.length > 0)
    .join("\n");
}

export function isFilesystemLeakPermissionRequest(params: any): boolean {
  const denied = deniedPathSubstrings();
  if (denied.length === 0) return false;
  const content =
    `${toolLabel(params)}\n${JSON.stringify(params?.toolCall ?? params ?? {})}`.toLowerCase();
  return denied.some((substring) => content.includes(substring));
}

export function isNetworkPermissionRequest(params: any): boolean {
  const label = toolLabel(params);
  const nested = JSON.stringify(params?.toolCall ?? params ?? {});
  // Search nested JSON too: Claude often puts `toolName: Bash` only in `_meta`.
  const haystack = `${label}\n${nested}`;
  if (NETWORK_TOOL_RE.test(haystack)) return true;
  if (!SHELL_TOOL_RE.test(haystack)) return false;
  return (
    NETWORK_BASH_RE.test(haystack) ||
    PACKAGE_INDEX_FETCH_RE.test(haystack) ||
    SCRIPT_NETWORK_RE.test(haystack)
  );
}

function denyOutcome(options: any[]): any {
  const reject = options.find((o: any) =>
    /reject|deny|cancel|abort|no/i.test(`${o?.optionId ?? ""} ${o?.name ?? ""} ${o?.label ?? ""}`)
  );
  if (reject?.optionId) {
    return {
      outcome: {
        outcome: "selected",
        optionId: reject.optionId,
      },
    };
  }
  return {
    outcome: {
      outcome: "cancelled",
    },
  };
}
import { invalidParams, methodNotFound } from "./error-utils.js";

export class PermissionHandler implements ClientMethodHandler {
  constructor(private readonly autoApprove: boolean = false) {}

  async handle(method: string, params: any): Promise<any> {
    if (method === "session/request_permission") {
      const title = params.title || params.toolCall?.title || "Permission Request";
      const message = params.message || params.toolCall?.description || "";
      const options = params.options || [];

      if (envFlagEnabled("ACP_DENY_NETWORK_TOOLS") && isNetworkPermissionRequest(params)) {
        console.error(
          `[Permission Denied][ACP_DENY_NETWORK_TOOLS] ${title}${
            message ? `: ${String(message).slice(0, 200)}` : ""
          }`
        );
        return denyOutcome(options);
      }

      if (isFilesystemLeakPermissionRequest(params)) {
        console.error(
          `[Permission Denied][ACP_DENY_PATH_SUBSTRINGS_JSON] ${title}${
            message ? `: ${String(message).slice(0, 200)}` : ""
          }`
        );
        return denyOutcome(options);
      }

      if (!Array.isArray(options) || options.length === 0) {
        throw invalidParams("session/request_permission requires at least one option", {
          options,
        });
      }

      if (this.autoApprove) {
        return {
          outcome: {
            outcome: "selected",
            optionId: options[0].optionId,
          },
        };
      }

      console.log(`\n[Permission Request] ${title}`);
      if (message) console.log(message);

      let choice: string;
      try {
        choice = await select({
          message: "Choose an action:",
          choices: options.map((o: any) => ({
            name: o.name || o.label || o.optionId,
            value: o.optionId,
          })),
        });
      } catch {
        return {
          outcome: {
            outcome: "cancelled",
          },
        };
      }

      return {
        outcome: {
          outcome: "selected",
          optionId: choice,
        },
      };
    }
    throw methodNotFound(method);
  }
}
