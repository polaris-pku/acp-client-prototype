import { ClientMethodHandler } from "./interface.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  invalidParams,
  mapFsError,
  methodNotFound,
  permissionDenied,
  requireStringParam,
} from "./error-utils.js";
import { WorkspaceBoundary } from "../security/workspace-boundary.js";
import { PermissionDeniedError } from "../core/errors.js";

export class FileSystemHandler implements ClientMethodHandler {
  private readonly boundary: WorkspaceBoundary;

  constructor(baseDir: string) {
    this.boundary = new WorkspaceBoundary(baseDir);
  }

  async handle(method: string, params: any): Promise<any> {
    const methodParams = this.requireObjectParams(method, params);

    switch (method) {
      case "fs/read_text_file":
        return await this.readFile(requireStringParam(methodParams, "path", method));
      case "fs/write_text_file":
        return await this.writeFile(
          requireStringParam(methodParams, "path", method),
          requireStringParam(methodParams, "content", method)
        );
      case "fs/list_directory":
        return await this.listDirectory(requireStringParam(methodParams, "path", method));
      default:
        throw methodNotFound(method);
    }
  }

  private async listDirectory(dirPath: string) {
    try {
      const fullPath = await this.boundary.resolveExisting(dirPath);
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      return {
        entries: entries.map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          isFile: e.isFile(),
        })),
      };
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        throw permissionDenied(err.message, { path: dirPath });
      }
      mapFsError(err, dirPath);
    }
  }

  private async readFile(filePath: string) {
    try {
      const fullPath = await this.boundary.resolveExisting(filePath);
      const content = await fs.readFile(fullPath, "utf-8");
      return { content };
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        throw permissionDenied(err.message, { path: filePath });
      }
      mapFsError(err, filePath);
    }
  }

  private async writeFile(filePath: string, content: string) {
    try {
      const fullPath = await this.boundary.resolveWritable(filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, "utf-8");
      return {};
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        throw permissionDenied(err.message, { path: filePath });
      }
      mapFsError(err, filePath);
    }
  }

  private requireObjectParams(method: string, params: unknown): Record<string, unknown> {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw invalidParams(`${method} requires object params`, { params });
    }

    return params as Record<string, unknown>;
  }
}
