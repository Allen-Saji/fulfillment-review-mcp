import { randomUUID } from "node:crypto";

import { reviewCaseSchema } from "../src/domain/types.js";
import { AppError } from "../src/errors.js";
import type {
  ReviewCaseStore,
  CreateReviewCaseResult,
} from "../src/infrastructure/review-case-store.js";

export interface InMemoryReviewCaseStoreDependencies {
  createId(): string;
  now(): string;
}

const defaultDependencies: InMemoryReviewCaseStoreDependencies = {
  createId: randomUUID,
  now: () => new Date().toISOString(),
};

export function openInMemoryReviewCaseStore(
  dependencies: InMemoryReviewCaseStoreDependencies = defaultDependencies,
): ReviewCaseStore {
  const byId = new Map<string, CreateReviewCaseResult["reviewCase"]>();
  const byEvidence = new Map<string, CreateReviewCaseResult["reviewCase"]>();
  let closed = false;

  function assertOpen(): void {
    if (closed) {
      throw new AppError(
        "STORAGE_UNAVAILABLE",
        "The review-case store is closed.",
      );
    }
  }

  return {
    createOrGet(draft) {
      return Promise.resolve().then(() => {
        assertOpen();
        const evidenceKey = `${draft.orderId}:${draft.evidenceVersion}`;
        const existing = byEvidence.get(evidenceKey);
        if (existing !== undefined) {
          return { reviewCase: structuredClone(existing), created: false };
        }
        const reviewCase = reviewCaseSchema.parse({
          ...draft,
          id: dependencies.createId(),
          createdAt: dependencies.now(),
        });
        if (byId.has(reviewCase.id)) {
          throw new AppError(
            "STORAGE_UNAVAILABLE",
            "The review case could not be persisted.",
          );
        }
        byId.set(reviewCase.id, structuredClone(reviewCase));
        byEvidence.set(evidenceKey, structuredClone(reviewCase));
        return { reviewCase, created: true };
      });
    },

    get(reviewCaseId) {
      return Promise.resolve().then(() => {
        assertOpen();
        const reviewCase = byId.get(reviewCaseId);
        if (reviewCase === undefined) {
          throw new AppError(
            "REVIEW_CASE_NOT_FOUND",
            `Review case ${reviewCaseId} was not found.`,
          );
        }
        return structuredClone(reviewCase);
      });
    },

    isReady() {
      return Promise.resolve(!closed);
    },

    close() {
      closed = true;
      return Promise.resolve();
    },
  };
}
