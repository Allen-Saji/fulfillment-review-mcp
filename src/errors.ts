export const appErrorCodes = [
  "ORDER_NOT_FOUND",
  "ORDER_NOT_ON_HOLD",
  "EVIDENCE_VERSION_MISMATCH",
  "REVIEW_CASE_NOT_FOUND",
  "INVALID_REQUEST",
  "STORAGE_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type AppErrorCode = (typeof appErrorCodes)[number];

export class AppError extends Error {
  override readonly name = "AppError";
  readonly code: AppErrorCode;

  constructor(code: AppErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError(
    "INTERNAL_ERROR",
    "The request could not be completed. Retry or contact the operator.",
    error instanceof Error ? { cause: error } : undefined,
  );
}
