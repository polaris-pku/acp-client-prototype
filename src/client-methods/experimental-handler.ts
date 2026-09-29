import { ClientMethodHandler } from "./interface.js";
import { methodNotFound } from "./error-utils.js";

export class ExperimentalHandler implements ClientMethodHandler {
  async handle(method: string, params: any): Promise<any> {
    switch (method) {
      case "experimental/echo":
        return { message: params.message };
      case "experimental/status":
        return { status: "ok", timestamp: new Date().toISOString() };
      default:
        throw methodNotFound(method);
    }
  }
}
