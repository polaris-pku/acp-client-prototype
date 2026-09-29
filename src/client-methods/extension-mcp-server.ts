import http from "node:http";
import { URL } from "node:url";
import { RequestError } from "@agentclientprotocol/sdk";
import { ExtensionMethod } from "./extension-loader.js";
import { AcpError, PermissionDeniedError } from "../core/errors.js";

export type ExtensionMcpToolHandler = (method: string, args: unknown) => Promise<unknown>;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface SseSession {
  res: http.ServerResponse;
}

export class ExtensionMcpServer {
  private server: http.Server;
  private port = 0;
  private sessions = new Map<string, SseSession>();
  private sockets = new Set<import("node:net").Socket>();
  private nextSessionId = 1;

  constructor(
    private readonly methods: ExtensionMethod[],
    private readonly handler: ExtensionMcpToolHandler
  ) {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  async start(): Promise<string> {
    if (this.port !== 0) return this.getSseUrl();

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to resolve extension MCP server address"));
          return;
        }
        this.port = address.port;
        resolve();
      };

      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, "127.0.0.1");
    });

    return this.getSseUrl();
  }

  async stop(): Promise<void> {
    if (this.port === 0) return;

    for (const session of this.sessions.values()) {
      try {
        session.res.end();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();

    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.sockets.clear();

    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.port = 0;
  }

  getSseUrl(): string {
    if (this.port === 0) throw new Error("Extension MCP server has not started");
    return `http://127.0.0.1:${this.port}/sse`;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || "/", `http://127.0.0.1:${this.port || 0}`);

    if (req.method === "GET" && url.pathname === "/sse") {
      this.handleSseConnection(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/message") {
      this.handleMessagePost(req, res, url);
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private handleSseConnection(req: http.IncomingMessage, res: http.ServerResponse): void {
    const sessionId = `session-${this.nextSessionId++}`;
    const messageEndpoint = `/message?session_id=${sessionId}`;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    this.sessions.set(sessionId, { res });
    this.sendSse(res, "endpoint", messageEndpoint);

    req.on("close", () => {
      this.sessions.delete(sessionId);
    });
  }

  private handleMessagePost(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const sessionId = url.searchParams.get("session_id");
    const session = sessionId ? this.sessions.get(sessionId) : undefined;

    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      let request: JsonRpcRequest | null = null;
      try {
        request = parseJsonRpcRequest(body);
        if (!session) {
          const response =
            request.id === undefined
              ? null
              : requestErrorResponse(request.id, {
                  code: -32600,
                  message: `Invalid request: unknown MCP session_id ${sessionId ?? "<missing>"}`,
                });
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(response ? JSON.stringify(response) : "");
          return;
        }

        const response = await this.handleJsonRpc(request);
        if (response) {
          this.sendSse(session.res, "message", JSON.stringify(response));
        }
        res.writeHead(202);
        res.end();
      } catch (err) {
        const error =
          err instanceof SyntaxError
            ? RequestError.parseError(undefined, err.message).toErrorResponse()
            : toJsonRpcError(err);
        const response =
          request?.id === undefined
            ? { jsonrpc: "2.0", error }
            : requestErrorResponse(request.id, error);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      }
    });
  }

  private async handleJsonRpc(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const { id, method, params } = request;

    if (id === undefined) return null;

    try {
      if (method === "initialize") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "acp-extension-methods", version: "1.0.0" },
          },
        };
      }

      if (method === "tools/list") {
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: this.methods.map((m) => this.toMcpTool(m)) },
        };
      }

      if (method === "tools/call") {
        const name = params?.name as string | undefined;
        const args = params?.arguments ?? {};
        if (!name) {
          return {
            jsonrpc: "2.0",
            id,
            error: RequestError.invalidParams(params, "Missing tool name").toErrorResponse(),
          };
        }

        if (!this.methods.some((m) => m.name === name)) {
          return {
            jsonrpc: "2.0",
            id,
            error: RequestError.methodNotFound(name).toErrorResponse(),
          };
        }

        const result = await this.handler(name, args);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
          },
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        error: RequestError.methodNotFound(method).toErrorResponse(),
      };
    } catch (err) {
      return { jsonrpc: "2.0", id, error: toJsonRpcError(err) };
    }
  }

  private toMcpTool(method: ExtensionMethod) {
    return {
      name: method.name,
      description: method.description,
      inputSchema: {
        type: "object",
        properties: this.toMcpProperties(method.params || {}),
      },
    };
  }

  private toMcpProperties(params: Record<string, any>): Record<string, any> {
    return Object.fromEntries(
      Object.entries(params).map(([name, type]) => [
        name,
        typeof type === "string" ? { type } : type,
      ])
    );
  }

  private sendSse(res: http.ServerResponse, event: string, data: string): void {
    res.write(`event: ${event}\n`);
    res.write(`data: ${data}\n\n`);
  }
}

function requestErrorResponse(
  id: number | string,
  error: JsonRpcResponse["error"]
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error,
  };
}

function parseJsonRpcRequest(body: string): JsonRpcRequest {
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw RequestError.invalidRequest(parsed, "Request must be an object");
  }
  if (parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
    throw RequestError.invalidRequest(parsed, "Request must include jsonrpc 2.0 and method");
  }
  if (parsed.id !== undefined && typeof parsed.id !== "string" && typeof parsed.id !== "number") {
    throw RequestError.invalidRequest(parsed, "Request id must be a string or number");
  }
  return parsed as JsonRpcRequest;
}

function toJsonRpcError(err: unknown): NonNullable<JsonRpcResponse["error"]> {
  if (err instanceof RequestError) {
    return err.toErrorResponse();
  }

  if (err instanceof PermissionDeniedError) {
    return RequestError.invalidRequest(err.data, err.message).toErrorResponse();
  }

  if (err instanceof AcpError) {
    return RequestError.internalError(err.data, err.message).toErrorResponse();
  }

  const message = err instanceof Error ? err.message : String(err);
  return RequestError.internalError(undefined, message).toErrorResponse();
}
