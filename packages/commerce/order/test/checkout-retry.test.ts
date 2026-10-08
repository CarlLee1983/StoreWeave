import { describe, expect, it } from 'vitest';
import { checkoutTransactionRetry, InconclusiveCheckoutError } from '../src/checkout-retry';

describe('checkout transaction retry classification', () => {
  it('retries diagnosed inconclusive reservations and aborted PostgreSQL transactions through wrapped causes', () => {
    expect(checkoutTransactionRetry.shouldRetry(new InconclusiveCheckoutError())).toBe(true);
    for (const code of ['40001', '40P01']) {
      expect(checkoutTransactionRetry.shouldRetry({ code })).toBe(true);
      expect(checkoutTransactionRetry.shouldRetry(new Error('query failed', { cause: { code } }))).toBe(true);
    }
    expect(checkoutTransactionRetry.maxAttempts).toBe(3);
  });

  it('does not automatically retry an uncertain connection or commit outcome, ordinary errors, or cyclic causes', () => {
    for (const error of [{ code: '08006' }, { code: 'ECONNRESET' }, new Error('commit outcome unknown'), null]) {
      expect(checkoutTransactionRetry.shouldRetry(error)).toBe(false);
    }
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(checkoutTransactionRetry.shouldRetry(cyclic)).toBe(false);
  });
});
