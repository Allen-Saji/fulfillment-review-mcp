import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { createHttpApplication } from "../src/http.js";
import {
  openReviewCaseStore,
  type ReviewCaseStore,
} from "../src/infrastructure/sqlite-review-case-store.js";
import { createSyntheticCommerceSource } from "../src/infrastructure/synthetic-commerce.js";
import { memoryLogger, startTestApplication, testConfig } from "./helpers.js";

interface RawResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function rawRequest(
  port: number,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string | number>;
    body?: string;
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

describe("HTTP application", () => {
  it("reports health and unknown routes without exposing configuration", async () => {
    const running = await startTestApplication();
    try {
      const health = await fetch(new URL("/health", running.endpoint).href);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });

      const missing = await fetch(new URL("/missing", running.endpoint).href);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "NOT_FOUND" });
    } finally {
      await running.close();
    }
  });

  it("reports unavailable health after storage closes", async () => {
    const running = await startTestApplication();
    try {
      running.store.close();
      const health = await fetch(new URL("/health", running.endpoint).href);
      expect(health.status).toBe(503);
      expect(await health.json()).toEqual({ status: "unavailable" });
    } finally {
      await running.close();
    }
  });

  it("rejects invalid Host and Origin headers", async () => {
    const running = await startTestApplication();
    const port = (running.application.server.address() as AddressInfo).port;
    try {
      const badHost = await rawRequest(port, {
        method: "GET",
        path: "/mcp",
        headers: { Host: "attacker.example" },
      });
      expect(badHost.statusCode).toBe(403);

      const badOrigin = await rawRequest(port, {
        method: "GET",
        path: "/mcp",
        headers: { Origin: "https://attacker.example" },
      });
      expect(badOrigin.statusCode).toBe(403);
    } finally {
      await running.close();
    }
  });

  it("rejects empty and malformed JSON bodies", async () => {
    const running = await startTestApplication();
    const port = (running.application.server.address() as AddressInfo).port;
    try {
      const empty = await rawRequest(port, {
        method: "POST",
        path: "/mcp",
      });
      expect(empty.statusCode).toBe(400);
      expect(empty.body).toContain("request body is empty");

      const malformed = await rawRequest(port, {
        method: "POST",
        path: "/mcp",
        body: "{invalid",
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.body).toContain("not valid JSON");
    } finally {
      await running.close();
    }
  });

  it("rejects oversized declared and chunked request bodies", async () => {
    const running = await startTestApplication({ maxRequestBodyBytes: 1024 });
    const port = (running.application.server.address() as AddressInfo).port;
    try {
      const declared = await rawRequest(port, {
        method: "POST",
        path: "/mcp",
        headers: { "Content-Length": 2_000 },
        body: "{}",
      });
      expect(declared.statusCode).toBe(413);

      const chunked = await rawRequest(port, {
        method: "POST",
        path: "/mcp",
        body: JSON.stringify({ value: "x".repeat(2_000) }),
      });
      expect(chunked.body).toContain("configured limit");
      expect(chunked.statusCode).toBe(413);
    } finally {
      await running.close();
    }
  });

  it("returns an MCP method response for GET and preserves safe request IDs", async () => {
    const running = await startTestApplication();
    const port = (running.application.server.address() as AddressInfo).port;
    try {
      const response = await rawRequest(port, {
        method: "GET",
        path: "/mcp",
        headers: { "X-Request-Id": "review-test-123" },
      });
      expect(response.statusCode).toBe(405);
      expect(response.headers["x-request-id"]).toBe("review-test-123");

      const generated = await rawRequest(port, {
        method: "GET",
        path: "/mcp",
        headers: { "X-Request-Id": "invalid request id" },
      });
      expect(generated.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await running.close();
    }
  });

  it("makes close idempotent", async () => {
    const logs: string[] = [];
    const store = openReviewCaseStore(":memory:");
    const application = createHttpApplication({
      config: testConfig(),
      commerceSource: createSyntheticCommerceSource(),
      reviewCaseStore: store,
      logger: memoryLogger(logs),
    });
    await new Promise<void>((resolve) =>
      application.server.listen(0, "127.0.0.1", resolve),
    );
    await application.close();
    await expect(application.close()).resolves.toBeUndefined();
  });

  it("sanitizes unexpected health-check failures", async () => {
    const logs: string[] = [];
    const underlyingStore = openReviewCaseStore(":memory:");
    const throwingStore: ReviewCaseStore = {
      ...underlyingStore,
      isReady() {
        throw new Error("private database detail");
      },
    };
    const application = createHttpApplication({
      config: testConfig(),
      commerceSource: createSyntheticCommerceSource(),
      reviewCaseStore: throwingStore,
      logger: memoryLogger(logs),
    });
    await new Promise<void>((resolve) =>
      application.server.listen(0, "127.0.0.1", resolve),
    );
    const port = (application.server.address() as AddressInfo).port;
    try {
      const response = await rawRequest(port, {
        method: "GET",
        path: "/health",
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).toContain("Internal server error");
      expect(response.body).not.toContain("private database detail");
      expect(logs).toContain("error:http_request_failed");
    } finally {
      await application.close();
    }
  });
});
