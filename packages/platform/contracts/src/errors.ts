/**
 * 平台統一錯誤型別。所有對外訊息必須是 user-safe，內部細節放 `details` 只寫進 log。
 */
export const HTTP_STATUS = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  IDEMPOTENCY_MISMATCH: 422,
  IDEMPOTENCY_IN_PROGRESS: 409,
  UNSUPPORTED: 501,
  EXTENSION_ERROR: 502,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof HTTP_STATUS;

export class PlatformError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'PlatformError';
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }

  static notFound(what: string, id?: string) {
    return new PlatformError('NOT_FOUND', id ? `${what} not found: ${id}` : `${what} not found`);
  }
  static validation(message: string, details?: unknown) {
    return new PlatformError('VALIDATION_ERROR', message, details);
  }
  static conflict(message: string, details?: unknown) {
    return new PlatformError('CONFLICT', message, details);
  }
  static forbidden(message: string) {
    return new PlatformError('FORBIDDEN', message);
  }
  static internal(message: string, details?: unknown) {
    return new PlatformError('INTERNAL_ERROR', message, details);
  }
}

/**
 * A job handler can throw this public contract error when retrying cannot make
 * progress. It lives in contracts so extensions can request dead-letter
 * handling without importing the queue implementation.
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export function httpStatusOf(err: unknown): number {
  return err instanceof PlatformError ? err.httpStatus : 500;
}

/** 對外錯誤 payload：永遠不洩漏內部細節。 */
export function toPublicError(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof PlatformError) {
    return { code: err.code, message: err.message };
  }
  return { code: 'INTERNAL_ERROR', message: 'Internal server error' };
}
