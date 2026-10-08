import type { TransactionRetryPolicy } from '@storeweave/contracts';

/** A failed reservation whose transaction-local diagnosis cannot confirm a shortage. */
export class InconclusiveCheckoutError extends Error {
  constructor() {
    super('Checkout reservation outcome is inconclusive');
    this.name = 'InconclusiveCheckoutError';
  }
}

function isRetryableCheckoutFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current instanceof InconclusiveCheckoutError) return true;
    const failure = current as { code?: unknown; cause?: unknown };
    // PostgreSQL guarantees these failed transactions were aborted. Connection
    // failures may have committed, so they must never be retried automatically.
    if (failure.code === '40001' || failure.code === '40P01') return true;
    current = failure.cause;
  }
  return false;
}

export const checkoutTransactionRetry: TransactionRetryPolicy = {
  maxAttempts: 3,
  shouldRetry: isRetryableCheckoutFailure,
  exhaustedMessage: '暫時無法處理，請以原識別鍵重試',
};
