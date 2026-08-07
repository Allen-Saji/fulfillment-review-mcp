import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Pool, type PoolClient } from "pg";

import { canonicalJson } from "../domain/canonical-json.js";
import {
  reviewCaseSchema,
  type ReviewCase,
  type ReviewCaseDraft,
} from "../domain/types.js";
import { AppError } from "../errors.js";
import type { ReviewCaseStore } from "./review-case-store.js";

interface ReviewCaseRow {
  payload_json: unknown;
}

interface MigrationRow {
  version: string;
}

export interface ReviewCaseStoreDependencies {
  createId(): string;
  now(): string;
}

export interface OpenPostgresReviewCaseStoreOptions {
  databaseUrl: string;
  migrationsDirectory?: string;
  dependencies?: ReviewCaseStoreDependencies;
}

const defaultDependencies: ReviewCaseStoreDependencies = {
  createId: randomUUID,
  now: () => new Date().toISOString(),
};

const migrationFilePattern = /^\d{3}_[a-z0-9_]+\.sql$/;
const migrationLockId = 7_346_182_041;

function parseRow(row: ReviewCaseRow): ReviewCase {
  try {
    return reviewCaseSchema.parse(row.payload_json);
  } catch (error) {
    throw new AppError(
      "STORAGE_UNAVAILABLE",
      "The stored review case could not be read safely.",
      { cause: error },
    );
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original database error.
  }
}

async function runMigrations(
  pool: Pool,
  migrationsDirectory: string,
): Promise<void> {
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((fileName) => migrationFilePattern.test(fileName))
    .sort();
  if (migrationFiles.length === 0) {
    throw new Error("No database migrations were found.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [migrationLockId]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const appliedResult = await client.query<MigrationRow>(
      "SELECT version FROM schema_migrations",
    );
    const applied = new Set(appliedResult.rows.map((row) => row.version));

    for (const fileName of migrationFiles) {
      if (applied.has(fileName)) {
        continue;
      }
      const migrationSql = await readFile(
        resolve(migrationsDirectory, fileName),
        "utf8",
      );
      await client.query(migrationSql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [fileName],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function openPostgresReviewCaseStore(
  options: OpenPostgresReviewCaseStoreOptions,
): Promise<ReviewCaseStore> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const migrationsDirectory =
    options.migrationsDirectory ?? resolve(process.cwd(), "migrations");
  const pool = new Pool({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 5,
  });

  try {
    await runMigrations(pool, migrationsDirectory);
    await pool.query("SELECT 1");
  } catch (error) {
    await pool.end();
    throw new AppError(
      "STORAGE_UNAVAILABLE",
      "PostgreSQL could not be initialized.",
      { cause: error },
    );
  }

  let closed = false;

  return {
    async createOrGet(draft: ReviewCaseDraft) {
      const reviewCase = reviewCaseSchema.parse({
        ...draft,
        id: dependencies.createId(),
        createdAt: dependencies.now(),
      });
      const idempotencyKey = `review-case:v1:${draft.orderId}:${draft.evidenceVersion}`;
      const client = await pool.connect().catch((error: unknown) => {
        throw new AppError(
          "STORAGE_UNAVAILABLE",
          "The review case could not be persisted.",
          { cause: error },
        );
      });

      try {
        await client.query("BEGIN");
        const inserted = await client.query<ReviewCaseRow>(
          `
            INSERT INTO review_cases (
              id,
              order_id,
              evidence_version,
              idempotency_key,
              payload_json,
              created_at
            ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
            ON CONFLICT (order_id, evidence_version) DO NOTHING
            RETURNING payload_json
          `,
          [
            reviewCase.id,
            reviewCase.orderId,
            reviewCase.evidenceVersion,
            idempotencyKey,
            canonicalJson(reviewCase),
            reviewCase.createdAt,
          ],
        );
        const insertedRow = inserted.rows[0];
        if (insertedRow !== undefined) {
          await client.query("COMMIT");
          return { reviewCase: parseRow(insertedRow), created: true };
        }

        const existing = await client.query<ReviewCaseRow>(
          `
            SELECT payload_json
            FROM review_cases
            WHERE order_id = $1 AND evidence_version = $2
          `,
          [draft.orderId, draft.evidenceVersion],
        );
        const existingRow = existing.rows[0];
        if (existingRow === undefined) {
          throw new Error("The conflicting review case was not found.");
        }
        await client.query("COMMIT");
        return { reviewCase: parseRow(existingRow), created: false };
      } catch (error) {
        await rollback(client);
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          "STORAGE_UNAVAILABLE",
          "The review case could not be persisted.",
          { cause: error },
        );
      } finally {
        client.release();
      }
    },

    async get(reviewCaseId: string) {
      try {
        const result = await pool.query<ReviewCaseRow>(
          "SELECT payload_json FROM review_cases WHERE id = $1",
          [reviewCaseId],
        );
        const row = result.rows[0];
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

    async isReady() {
      if (closed) {
        return false;
      }
      try {
        await pool.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },

    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await pool.end();
    },
  } satisfies ReviewCaseStore;
}
