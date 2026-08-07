import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";

describe("configuration", () => {
  it("requires PostgreSQL and uses safe network defaults", () => {
    expect(() => loadConfig({})).toThrow();
    expect(
      loadConfig({
        DATABASE_URL: "postgresql://localhost/fulfillment_review",
      }),
    ).toEqual({
      host: "127.0.0.1",
      port: 3000,
      databaseUrl: "postgresql://localhost/fulfillment_review",
      allowedHosts: ["localhost", "127.0.0.1"],
      allowedOriginHosts: ["localhost", "127.0.0.1"],
      logLevel: "info",
    });
  });

  it("parses explicit deployment configuration", () => {
    expect(
      loadConfig({
        HOST: "0.0.0.0",
        PORT: "8080",
        DATABASE_URL: "postgresql://db.example.com/fulfillment_review",
        ALLOWED_HOSTS: "mcp.example.com, localhost",
        ALLOWED_ORIGIN_HOSTS: "app.example.com",
        LOG_LEVEL: "debug",
      }),
    ).toEqual({
      host: "0.0.0.0",
      port: 8080,
      databaseUrl: "postgresql://db.example.com/fulfillment_review",
      allowedHosts: ["mcp.example.com", "localhost"],
      allowedOriginHosts: ["app.example.com"],
      logLevel: "debug",
    });
  });

  it("rejects invalid ports and empty allowlists", () => {
    const required = {
      DATABASE_URL: "postgresql://localhost/fulfillment_review",
    };
    expect(() => loadConfig({ ...required, PORT: "70000" })).toThrow();
    expect(() => loadConfig({ ...required, ALLOWED_HOSTS: " , " })).toThrow();
    expect(() =>
      loadConfig({ DATABASE_URL: "https://db.example.com/database" }),
    ).toThrow();
  });
});

describe("structured logger", () => {
  it("filters low-priority logs and excludes undefined fields", () => {
    const lines: string[] = [];
    const logger = createLogger("warn", (line) => lines.push(line));
    logger.debug("debug_event");
    logger.info("info_event");
    logger.warn("warn_event", { retained: true, omitted: undefined });
    logger.error("error_event", { count: 2, empty: null });

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: "warn",
      event: "warn_event",
      retained: true,
    });
    expect(lines[0]).not.toContain("omitted");
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({
      level: "error",
      event: "error_event",
      count: 2,
      empty: null,
    });
  });

  it("uses stdout by default", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    createLogger("debug").debug("default_writer");
    expect(spy).toHaveBeenCalledOnce();
  });
});
