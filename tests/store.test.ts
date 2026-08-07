import { resolve } from "node:path";

import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { investigateFulfillmentHold } from "../src/domain/evidence.js";
import { calculateFulfillmentOptions } from "../src/domain/options.js";
import { buildReviewCaseDraft } from "../src/domain/review-case.js";
import type { ReviewCaseDraft } from "../src/domain/types.js";
import { AppError } from "../src/errors.js";
import { openPostgresReviewCaseStore } from "../src/infrastructure/postgres-review-case-store.js";
import {
  createSyntheticCommerceSource,
  SYNTHETIC_ORDER_ID,
} from "../src/infrastructure/synthetic-commerce.js";

const fixedId = "11111111-1111-4111-8111-111111111111";
const fixedTime = "2026-08-01T12:00:00.000Z";
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for PostgreSQL integration tests.");
}

const adminPool = new Pool({ connectionString: databaseUrl });
const migrationsDirectory = resolve(process.cwd(), "migrations");

function draft(): ReviewCaseDraft {
  const investigation = investigateFulfillmentHold(
    createSyntheticCommerceSource(),
    SYNTHETIC_ORDER_ID,
  );
  return buildReviewCaseDraft(
    investigation,
    calculateFulfillmentOptions(investigation),
  );
}

async function errorCode(
  action: () => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : undefined;
  }
}

describe("PostgreSQL review case store", { concurrent: false }, () => {
  beforeEach(async () => {
    await adminPool.query(
      "DROP TABLE IF EXISTS review_cases; DROP TABLE IF EXISTS schema_migrations;",
    );
  });

  afterAll(async () => {
    await adminPool.end();
  });

  it("applies migrations and creates, reads, and idempotently returns a case", async () => {
    const store = await openPostgresReviewCaseStore({
      databaseUrl,
      migrationsDirectory,
      dependencies: {
        createId: () => fixedId,
        now: () => fixedTime,
      },
    });

    const first = await store.createOrGet(draft());
    const second = await store.createOrGet(draft());
    const readBack = await store.get(fixedId);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.reviewCase.id).toBe(first.reviewCase.id);
    expect(readBack).toEqual(first.reviewCase);
    expect(await store.isReady()).toBe(true);
    expect(
      await adminPool.query("SELECT version FROM schema_migrations"),
    ).toMatchObject({ rows: [{ version: "001_create_review_cases.sql" }] });

    await store.close();
    await store.close();
    expect(await store.isReady()).toBe(false);
  });

  it("returns one canonical case under concurrent creation", async () => {
    const store = await openPostgresReviewCaseStore({
      databaseUrl,
      migrationsDirectory,
    });
    const results = await Promise.all([
      store.createOrGet(draft()),
      store.createOrGet(draft()),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.reviewCase.id)).size).toBe(1);
    await store.close();
  });

  it("serializes concurrent migration attempts", async () => {
    const [first, second] = await Promise.all([
      openPostgresReviewCaseStore({ databaseUrl, migrationsDirectory }),
      openPostgresReviewCaseStore({ databaseUrl, migrationsDirectory }),
    ]);

    expect(await first.isReady()).toBe(true);
    expect(await second.isReady()).toBe(true);
    const migrationCount = await adminPool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM schema_migrations",
    );
    expect(migrationCount.rows[0]?.count).toBe("1");
    await first.close();
    await second.close();
  });

  it("returns a stable not-found error", async () => {
    const store = await openPostgresReviewCaseStore({
      databaseUrl,
      migrationsDirectory,
    });
    expect(
      await errorCode(() => store.get("22222222-2222-4222-8222-222222222222")),
    ).toBe("REVIEW_CASE_NOT_FOUND");
    await store.close();
  });

  it("persists a valid case across store instances", async () => {
    const store = await openPostgresReviewCaseStore({
      databaseUrl,
      migrationsDirectory,
    });
    const result = await store.createOrGet(draft());
    await store.close();

    const reopened = await openPostgresReviewCaseStore({
      databaseUrl,
      migrationsDirectory,
    });
    expect(await reopened.get(result.reviewCase.id)).toEqual(result.reviewCase);
    await reopened.close();
  });

  it("fails safely when persisted JSON violates the schema", async () => {
    const store = await openPostgresReviewCaseStore({
      databaseUrl,
      migrationsDirectory,
      dependencies: {
        createId: () => fixedId,
        now: () => fixedTime,
      },
    });
    await store.createOrGet(draft());
    await adminPool.query(
      "UPDATE review_cases SET payload_json = $1::jsonb WHERE id = $2",
      [JSON.stringify({ invalid: true }), fixedId],
    );

    expect(await errorCode(() => store.get(fixedId))).toBe(
      "STORAGE_UNAVAILABLE",
    );
    expect(await errorCode(() => store.createOrGet(draft()))).toBe(
      "STORAGE_UNAVAILABLE",
    );
    await store.close();
  });

  it("maps closed database operations to storage errors", async () => {
    const store = await openPostgresReviewCaseStore({
      databaseUrl,
      migrationsDirectory,
    });
    await store.close();
    expect(await errorCode(() => store.createOrGet(draft()))).toBe(
      "STORAGE_UNAVAILABLE",
    );
    expect(
      await errorCode(() => store.get("22222222-2222-4222-8222-222222222222")),
    ).toBe("STORAGE_UNAVAILABLE");
  });

  it("fails safely on a generated primary-key collision", async () => {
    const store = await openPostgresReviewCaseStore({
      databaseUrl,
      migrationsDirectory,
      dependencies: {
        createId: () => fixedId,
        now: () => fixedTime,
      },
    });
    await store.createOrGet(draft());

    const differentDraft = structuredClone(draft());
    differentDraft.evidenceVersion = "a".repeat(64);
    differentDraft.investigation.evidenceVersion =
      differentDraft.evidenceVersion;
    differentDraft.preview.evidenceVersion = differentDraft.evidenceVersion;

    expect(await errorCode(() => store.createOrGet(differentDraft))).toBe(
      "STORAGE_UNAVAILABLE",
    );
    await store.close();
  });
});
