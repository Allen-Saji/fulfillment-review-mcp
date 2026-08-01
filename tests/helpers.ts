import type { AddressInfo } from "node:net";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import type { AppConfig } from "../src/config.js";
import type { CommerceSource } from "../src/domain/evidence.js";
import { createHttpApplication, type HttpApplication } from "../src/http.js";
import {
  openReviewCaseStore,
  type ReviewCaseStore,
} from "../src/infrastructure/sqlite-review-case-store.js";
import { createSyntheticCommerceSource } from "../src/infrastructure/synthetic-commerce.js";
import type { Logger } from "../src/logger.js";

export interface StartedTestApplication {
  application: HttpApplication;
  client: Client;
  endpoint: URL;
  logs: string[];
  store: ReviewCaseStore;
  close(): Promise<void>;
}

export function memoryLogger(lines: string[]): Logger {
  function write(level: string, event: string): void {
    lines.push(`${level}:${event}`);
  }
  return {
    debug: (event) => {
      write("debug", event);
    },
    info: (event) => {
      write("info", event);
    },
    warn: (event) => {
      write("warn", event);
    },
    error: (event) => {
      write("error", event);
    },
  };
}

export function testConfig(): AppConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    databasePath: ":memory:",
    allowedHosts: ["127.0.0.1", "localhost"],
    allowedOriginHosts: ["127.0.0.1", "localhost"],
    logLevel: "error",
  };
}

export async function startTestApplication(options?: {
  commerceSource?: CommerceSource;
  maxRequestBodyBytes?: number;
}): Promise<StartedTestApplication> {
  const logs: string[] = [];
  const store = openReviewCaseStore(":memory:", {
    createId: () => "11111111-1111-4111-8111-111111111111",
    now: () => "2026-08-01T12:00:00.000Z",
  });
  const application = createHttpApplication({
    config: testConfig(),
    commerceSource: options?.commerceSource ?? createSyntheticCommerceSource(),
    reviewCaseStore: store,
    logger: memoryLogger(logs),
    ...(options?.maxRequestBodyBytes === undefined
      ? {}
      : { maxRequestBodyBytes: options.maxRequestBodyBytes }),
  });

  await new Promise<void>((resolve, reject) => {
    application.server.once("error", reject);
    application.server.listen(0, "127.0.0.1", resolve);
  });
  const address = application.server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${String(address.port)}/mcp`);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(endpoint));

  return {
    application,
    client,
    endpoint,
    logs,
    store,
    async close() {
      await client.close();
      await application.close();
    },
  };
}
