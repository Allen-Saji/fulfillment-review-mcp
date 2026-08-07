import type { ReviewCase, ReviewCaseDraft } from "../domain/types.js";

export interface CreateReviewCaseResult {
  reviewCase: ReviewCase;
  created: boolean;
}

export interface ReviewCaseStore {
  createOrGet(draft: ReviewCaseDraft): Promise<CreateReviewCaseResult>;
  get(reviewCaseId: string): Promise<ReviewCase>;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}
