import { AppError } from "../errors.js";
import type {
  FulfillmentPreview,
  InvestigationResult,
  ReviewCaseDraft,
} from "./types.js";

export function assertEvidenceVersion(
  expectedVersion: string,
  actualVersion: string,
): void {
  if (expectedVersion !== actualVersion) {
    throw new AppError(
      "EVIDENCE_VERSION_MISMATCH",
      "The commerce evidence changed. Investigate the hold again before continuing.",
    );
  }
}

export function buildReviewCaseDraft(
  investigation: InvestigationResult,
  preview: FulfillmentPreview,
): ReviewCaseDraft {
  if (
    investigation.orderId !== preview.orderId ||
    investigation.evidenceVersion !== preview.evidenceVersion
  ) {
    throw new AppError(
      "INTERNAL_ERROR",
      "The investigation and option preview do not describe the same evidence.",
    );
  }

  return {
    workflowVersion: "1",
    status: "PENDING_HUMAN_REVIEW",
    orderId: investigation.orderId,
    evidenceVersion: investigation.evidenceVersion,
    investigation,
    preview,
  };
}
