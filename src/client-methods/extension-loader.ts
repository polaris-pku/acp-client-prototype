import fs from "node:fs";
import { ConfigurationError } from "../core/errors.js";

export interface ExtensionMethod {
  name: string;
  description: string;
  params?: Record<string, any>;
}

export function loadExtensionConfig(configPath: string): ExtensionMethod[] {
  if (!fs.existsSync(configPath)) {
    throw new ConfigurationError(`Extension config file not found: ${configPath}`, {
      configPath,
    });
  }
  const content = fs.readFileSync(configPath, "utf-8");
  try {
    const methods = configPath.endsWith(".json")
      ? parseJsonExtensionConfig(content)
      : parseSimpleYaml(content);
    return validateExtensionMethods(methods, configPath);
  } catch (err) {
    if (err instanceof ConfigurationError) {
      throw err;
    }
    throw new ConfigurationError(
      `Failed to load extension config ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      { configPath }
    );
  }
}

function parseJsonExtensionConfig(content: string): ExtensionMethod[] {
  const parsed = JSON.parse(content);
  return parsed.methods || parsed;
}

function parseSimpleYaml(content: string): ExtensionMethod[] {
  const lines = content.split(/\r?\n/);
  const methods: ExtensionMethod[] = [];
  let currentMethod: Partial<ExtensionMethod> | null = null;
  let inParams = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line === "methods:") {
      inParams = false;
      continue;
    }

    if (line.startsWith("-")) {
      if (currentMethod && currentMethod.name) {
        methods.push(currentMethod as ExtensionMethod);
      }
      currentMethod = {};
      inParams = false;

      const kv = line.slice(1).trim();
      if (kv) {
        parseKeyValue(kv, currentMethod);
      }
      continue;
    }

    if (currentMethod) {
      if (line.startsWith("params:")) {
        inParams = true;
        currentMethod.params = {};
        continue;
      }

      if (inParams && line.includes(":")) {
        const parts = line.split(":");
        const pKey = parts[0].trim();
        const pVal = parts.slice(1).join(":").trim();
        if (currentMethod.params) {
          currentMethod.params[pKey] = pVal.replace(/^['"]|['"]$/g, "");
        }
        continue;
      }

      if (line.includes(":")) {
        parseKeyValue(line, currentMethod);
      }
    }
  }

  if (currentMethod && currentMethod.name) {
    methods.push(currentMethod as ExtensionMethod);
  }

  return methods;
}

function parseKeyValue(line: string, target: any) {
  const parts = line.split(":");
  const key = parts[0].trim();
  const value = parts
    .slice(1)
    .join(":")
    .trim()
    .replace(/^['"]|['"]$/g, "");
  if (key === "name") target.name = value;
  else if (key === "description") target.description = value;
}

function validateExtensionMethods(methods: unknown, configPath: string): ExtensionMethod[] {
  if (!Array.isArray(methods)) {
    throw new ConfigurationError("Extension config must contain a methods array", {
      configPath,
      methods,
    });
  }

  const seen = new Set<string>();
  return methods.map((method, index) => {
    if (!method || typeof method !== "object") {
      throw new ConfigurationError("Extension method entry must be an object", {
        configPath,
        index,
        method,
      });
    }

    const candidate = method as Partial<ExtensionMethod>;
    if (typeof candidate.name !== "string" || candidate.name.length === 0) {
      throw new ConfigurationError("Extension method entry requires a non-empty name", {
        configPath,
        index,
      });
    }

    if (seen.has(candidate.name)) {
      throw new ConfigurationError(`Duplicate extension method: ${candidate.name}`, {
        configPath,
        index,
        name: candidate.name,
      });
    }
    seen.add(candidate.name);

    if (typeof candidate.description !== "string" || candidate.description.length === 0) {
      throw new ConfigurationError("Extension method entry requires a non-empty description", {
        configPath,
        index,
        name: candidate.name,
      });
    }

    return {
      name: candidate.name,
      description: candidate.description,
      params: candidate.params,
    };
  });
}
