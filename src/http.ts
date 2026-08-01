import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  hostHeaderValidation,
  originValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import type { AppConfig } from "./config.js";
import type { CommerceSource } from "./domain/evidence.js";
import type { ReviewCaseStore } from "./infrastructure/sqlite-review-case-store.js";
import type { Logger } from "./logger.js";
import { buildMcpServer } from "./server.js";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

class HttpRequestError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface HttpApplicationDependencies {
  config: AppConfig;
  commerceSource: CommerceSource;
  reviewCaseStore: ReviewCaseStore;
  logger: Logger;
  maxRequestBodyBytes?: number;
}

type CompleteIncomingMessage = IncomingMessage & {
  method: string;
  url: string;
};

export interface HttpApplication {
  server: Server;
  close(): Promise<void>;
}

function requestId(request: IncomingMessage): string {
  const supplied = request.headers["x-request-id"];
  if (typeof supplied === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(supplied)) {
    return supplied;
  }
  return randomUUID();
}

function pathName(request: CompleteIncomingMessage): string {
  return new URL(request.url, "http://localhost").pathname;
}

function respondJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  if (response.headersSent || response.destroyed) {
    return;
  }
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (
    typeof contentLength === "string" &&
    Number.parseInt(contentLength, 10) > maximumBytes
  ) {
    request.resume();
    throw new HttpRequestError(
      413,
      "The request body exceeds the configured limit.",
    );
  }

  const chunks: Buffer[] = [];
  let byteLength = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    byteLength += buffer.byteLength;
    if (byteLength > maximumBytes) {
      tooLarge = true;
    } else {
      chunks.push(buffer);
    }
  }

  if (tooLarge) {
    throw new HttpRequestError(
      413,
      "The request body exceeds the configured limit.",
    );
  }
  if (byteLength === 0) {
    throw new HttpRequestError(400, "The request body is empty.");
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpRequestError(400, "The request body is not valid JSON.");
  }
}

export function createHttpApplication(
  dependencies: HttpApplicationDependencies,
): HttpApplication {
  const toolDependencies = {
    commerceSource: dependencies.commerceSource,
    reviewCaseStore: dependencies.reviewCaseStore,
    logger: dependencies.logger,
  };
  const mcpHandler = createMcpHandler(() => buildMcpServer(toolDependencies), {
    legacy: "stateless",
    responseMode: "auto",
    onerror: (error) => {
      dependencies.logger.error("mcp_handler_failed", {
        errorName: error.name,
      });
    },
  });
  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => {
      dependencies.logger.error("mcp_adapter_failed", {
        errorName: error.name,
      });
    },
  });
  const validateHost = hostHeaderValidation(dependencies.config.allowedHosts);
  const validateOrigin = originValidation(
    dependencies.config.allowedOriginHosts,
  );
  const maximumBodyBytes =
    dependencies.maxRequestBodyBytes ?? MAX_REQUEST_BODY_BYTES;

  const server = createServer((request, response) => {
    // Node supplies method and url for ordinary HTTP requests. This narrows the
    // platform type once at the adapter boundary for the MCP SDK's stricter type.
    const completeRequest = request as CompleteIncomingMessage;
    const correlationId = requestId(request);
    const startedAt = performance.now();
    response.setHeader("x-request-id", correlationId);
    response.once("finish", () => {
      dependencies.logger.info("http_request_completed", {
        requestId: correlationId,
        method: completeRequest.method,
        route: completeRequest.url,
        statusCode: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });

    void (async () => {
      try {
        const route = pathName(completeRequest);
        if (route === "/health" && completeRequest.method === "GET") {
          const ready = dependencies.reviewCaseStore.isReady();
          respondJson(response, ready ? 200 : 503, {
            status: ready ? "ok" : "unavailable",
          });
          return;
        }

        if (route !== "/mcp") {
          respondJson(response, 404, { error: "NOT_FOUND" });
          return;
        }

        if (
          !validateHost(completeRequest, response) ||
          !validateOrigin(completeRequest, response)
        ) {
          return;
        }

        if (completeRequest.method === "POST") {
          const parsedBody = await readJsonBody(
            completeRequest,
            maximumBodyBytes,
          );
          await nodeMcpHandler(completeRequest, response, parsedBody);
          return;
        }

        await nodeMcpHandler(completeRequest, response);
      } catch (error) {
        if (error instanceof HttpRequestError) {
          if (error.statusCode === 413) {
            response.setHeader("connection", "close");
          }
          respondJson(response, error.statusCode, {
            jsonrpc: "2.0",
            error: { code: -32_000, message: error.message },
            id: null,
          });
          return;
        }
        dependencies.logger.error("http_request_failed", {
          requestId: correlationId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        respondJson(response, 500, {
          jsonrpc: "2.0",
          error: { code: -32_603, message: "Internal server error." },
          id: null,
        });
      }
    })();
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  let closed = false;
  return {
    server,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
      await mcpHandler.close();
      dependencies.reviewCaseStore.close();
    },
  };
}
