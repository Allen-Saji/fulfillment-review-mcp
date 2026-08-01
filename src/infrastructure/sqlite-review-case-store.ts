import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { canonicalJson } from "../domain/canonical-json.js";
import {
  reviewCaseSchema,
  type ReviewCase,
  type ReviewCaseDraft,
} from "../domain/types.js";
import { AppError } from "../errors.js";

interface ReviewCaseRow {
  payload_json: string;
}

export interface CreateReviewCaseResult {
  reviewCase: ReviewCase;
  created: boolean;
}

export interface ReviewCaseStore {
  createOrGet(draft: ReviewCaseDraft): CreateReviewCaseResult;
  get(reviewCaseId: string): ReviewCase;
  isReady(): boolean;
  close(): void;
}

export interface ReviewCaseStoreDependencies {
  createId(): string;
  now(): string;
}

const defaultDependencies: ReviewCaseStoreDependencies = {
  createId: randomUUID,
  now: () => new Date().toISOString(),
};

function isConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

function parseRow(row: ReviewCaseRow): ReviewCase {
  try {
    return reviewCaseSchema.parse(JSON.parse(row.payload_json) as unknown);
  } catch (error) {
    throw new AppError(
      "STORAGE_UNAVAILABLE",
      "The stored review case could not be read safely.",
      { cause: error },
    );
  }
}

export function openReviewCaseStore(
  databasePath: string,
  dependencies: ReviewCaseStoreDependencies = defaultDependencies,
): ReviewCaseStore {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  if (databasePath !== ":memory:") {
    database.pragma("journal_mode = WAL");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS review_cases (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      evidence_version TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(order_id, evidence_version)
    ) STRICT;
  `);

  const selectByEvidence = database.prepare<
    [orderId: string, evidenceVersion: string],
    ReviewCaseRow
  >(`
    SELECT payload_json
    FROM review_cases
    WHERE order_id = ? AND evidence_version = ?
  `);
  const selectById = database.prepare<[reviewCaseId: string], ReviewCaseRow>(`
    SELECT payload_json
    FROM review_cases
    WHERE id = ?
  `);
  const insert = database.prepare(`
    INSERT INTO review_cases (
      id,
      order_id,
      evidence_version,
      idempotency_key,
      payload_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const createTransaction = database.transaction(
    (draft: ReviewCaseDraft): CreateReviewCaseResult => {
      const existing = selectByEvidence.get(
        draft.orderId,
        draft.evidenceVersion,
      );
      if (existing !== undefined) {
        return { reviewCase: parseRow(existing), created: false };
      }

      const reviewCase = reviewCaseSchema.parse({
        ...draft,
        id: dependencies.createId(),
        createdAt: dependencies.now(),
      });
      const idempotencyKey = `review-case:v1:${draft.orderId}:${draft.evidenceVersion}`;

      try {
        insert.run(
          reviewCase.id,
          reviewCase.orderId,
          reviewCase.evidenceVersion,
          idempotencyKey,
          canonicalJson(reviewCase),
          reviewCase.createdAt,
        );
        return { reviewCase, created: true };
      } catch (error) {
        if (!isConstraintError(error)) {
          throw error;
        }
        const concurrentlyCreated = selectByEvidence.get(
          draft.orderId,
          draft.evidenceVersion,
        );
        if (concurrentlyCreated === undefined) {
          throw error;
        }
        return {
          reviewCase: parseRow(concurrentlyCreated),
          created: false,
        };
      }
    },
  );

  let closed = false;

  return {
    createOrGet(draft) {
      try {
        return createTransaction.immediate(draft);
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          "STORAGE_UNAVAILABLE",
          "The review case could not be persisted.",
          { cause: error },
        );
      }
    },

    get(reviewCaseId) {
      try {
        const row = selectById.get(reviewCaseId);
        if (row === undefined) {
          throw new AppError(
            "REVIEW_CASE_NOT_FOUND",
            `Review case ${reviewCaseId} was not found.`,
          );
        }
        return parseRow(row);
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          "STORAGE_UNAVAILABLE",
          "The review case could not be read.",
          { cause: error },
        );
      }
    },

    isReady() {
      if (closed) {
        return false;
      }
      try {
        database.prepare("SELECT 1").pluck().get();
        return true;
      } catch {
        return false;
      }
    },

    close() {
      if (!closed) {
        closed = true;
        database.close();
      }
    },
  };
}
