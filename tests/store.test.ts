import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { investigateFulfillmentHold } from "../src/domain/evidence.js";
import { calculateFulfillmentOptions } from "../src/domain/options.js";
import { buildReviewCaseDraft } from "../src/domain/review-case.js";
import type { ReviewCaseDraft } from "../src/domain/types.js";
import { AppError } from "../src/errors.js";
import { openReviewCaseStore } from "../src/infrastructure/sqlite-review-case-store.js";
import {
  createSyntheticCommerceSource,
  SYNTHETIC_ORDER_ID,
} from "../src/infrastructure/synthetic-commerce.js";

const fixedId = "11111111-1111-4111-8111-111111111111";
const fixedTime = "2026-08-01T12:00:00.000Z";

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

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : undefined;
  }
}

describe("SQLite review case store", () => {
  it("creates, reads, and idempotently returns an immutable review case", () => {
    const store = openReviewCaseStore(":memory:", {
      createId: () => fixedId,
      now: () => fixedTime,
    });

    const first = store.createOrGet(draft());
    const second = store.createOrGet(draft());
    const readBack = store.get(fixedId);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.reviewCase.id).toBe(first.reviewCase.id);
    expect(readBack).toEqual(first.reviewCase);
    expect(store.isReady()).toBe(true);

    store.close();
    store.close();
    expect(store.isReady()).toBe(false);
  });

  it("returns a stable not-found error", () => {
    const store = openReviewCaseStore(":memory:");
    expect(
      errorCode(() => store.get("22222222-2222-4222-8222-222222222222")),
    ).toBe("REVIEW_CASE_NOT_FOUND");
    store.close();
  });

  it("persists a valid case in a file-backed WAL database", () => {
    const directory = mkdtempSync(join(tmpdir(), "fulfillment-review-store-"));
    const databasePath = join(directory, "review-cases.sqlite");
    const store = openReviewCaseStore(databasePath);
    const result = store.createOrGet(draft());
    expect(result.reviewCase.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.reviewCase.createdAt).toMatch(/^2026-/);
    store.close();

    const reopened = openReviewCaseStore(databasePath);
    expect(reopened.get(result.reviewCase.id)).toEqual(result.reviewCase);
    reopened.close();
  });

  it("fails safely when persisted JSON is malformed", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "fulfillment-review-corrupt-"),
    );
    const databasePath = join(directory, "review-cases.sqlite");
    const store = openReviewCaseStore(databasePath, {
      createId: () => fixedId,
      now: () => fixedTime,
    });
    store.createOrGet(draft());

    const database = new Database(databasePath);
    database
      .prepare("UPDATE review_cases SET payload_json = ? WHERE id = ?")
      .run("{not-json", fixedId);
    database.close();

    expect(errorCode(() => store.get(fixedId))).toBe("STORAGE_UNAVAILABLE");
    expect(errorCode(() => store.createOrGet(draft()))).toBe(
      "STORAGE_UNAVAILABLE",
    );
    store.close();
  });

  it("maps closed database operations to storage errors", () => {
    const store = openReviewCaseStore(":memory:");
    store.close();
    expect(errorCode(() => store.createOrGet(draft()))).toBe(
      "STORAGE_UNAVAILABLE",
    );
    expect(
      errorCode(() => store.get("22222222-2222-4222-8222-222222222222")),
    ).toBe("STORAGE_UNAVAILABLE");
  });

  it("fails safely on a generated primary-key collision", () => {
    const store = openReviewCaseStore(":memory:", {
      createId: () => fixedId,
      now: () => fixedTime,
    });
    store.createOrGet(draft());

    const differentDraft = structuredClone(draft());
    differentDraft.evidenceVersion = "a".repeat(64);
    differentDraft.investigation.evidenceVersion =
      differentDraft.evidenceVersion;
    differentDraft.preview.evidenceVersion = differentDraft.evidenceVersion;

    expect(errorCode(() => store.createOrGet(differentDraft))).toBe(
      "STORAGE_UNAVAILABLE",
    );
    store.close();
  });
});
