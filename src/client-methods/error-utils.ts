import { RequestError } from "@agentclientprotocol/sdk";

export function methodNotFound(method: string): RequestError {
  return RequestError.methodNotFound(method);
}

export function invalidParams(message: string, data?: unknown): RequestError {
  return RequestError.invalidParams(data, message);
}

export function resourceNotFound(path?: string): RequestError {
  return RequestError.resourceNotFound(path);
}

export function permissionDenied(message: string, data?: unknown): RequestError {
  return new RequestError(-32003, message, data);
}

export function internalError(message: string, data?: unknown): RequestError {
  return RequestError.internalError(data, message);
}

export function mapFsError(err: unknown, targetPath: string): never {
  if (isNodeError(err)) {
    if (err.code === "ENOENT") {
      throw resourceNotFound(targetPath);
    }

    if (err.code === "ENOTDIR" || err.code === "EISDIR") {
      throw invalidParams(`Invalid filesystem path: ${targetPath}`, {
        path: targetPath,
        code: err.code,
      });
    }

    if (err.code === "EACCES" || err.code === "EPERM") {
      throw permissionDenied(`Access denied: ${targetPath}`, {
        path: targetPath,
        code: err.code,
      });
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  throw internalError(message, { path: targetPath });
}

export function requireStringParam(
  params: Record<string, unknown>,
  name: string,
  method: string
): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw invalidParams(`${method} requires a non-empty string parameter: ${name}`, {
      param: name,
      value,
    });
  }
  return value;
}

export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
