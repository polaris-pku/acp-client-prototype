import { ClientMethodHandler } from "./interface.js";
import { methodNotFound } from "./error-utils.js";

export class ClientMethodRouter {
  private handlers = new Map<string, ClientMethodHandler>();

  register(prefix: string, handler: ClientMethodHandler) {
    this.handlers.set(prefix, handler);
  }

  async route(method: string, params: any): Promise<any> {
    const parts = method.split("/");
    const prefix = parts[0];

    // Check for exact method first
    let handler = this.handlers.get(method);
    if (!handler) {
      // Then check for prefix (e.g. "fs", "terminal", "session")
      handler = this.handlers.get(prefix);
    }

    if (!handler) {
      throw methodNotFound(method);
    }

    return await handler.handle(method, params);
  }
}
