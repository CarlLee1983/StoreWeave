import { describe, expect, it } from 'vitest';
import { recordPaymentResultInput } from '../src/dto';

const base = { attemptRef: 'attempt-1', provider: 'provider-1' };

describe('recordPaymentResultInput', () => {
  it('requires exactly the fields that the normalized result status needs', () => {
    expect(recordPaymentResultInput.safeParse({ ...base, status: 'confirmed', providerRef: 'trade-1' }).success).toBe(true);
    expect(recordPaymentResultInput.safeParse({ ...base, status: 'redirect', providerRef: 'trade-1', action: { type: 'redirect', url: 'https://pay.example.test' } }).success).toBe(true);
    expect(recordPaymentResultInput.safeParse({ ...base, status: 'awaiting_payment', providerRef: 'trade-1', instructions: [{ label: '帳號', value: '123' }], expiresAt: new Date('2026-08-25T00:00:00.000Z') }).success).toBe(true);
    expect(recordPaymentResultInput.safeParse({ ...base, status: 'failed', message: 'declined' }).success).toBe(true);

    expect(recordPaymentResultInput.safeParse({ ...base, status: 'confirmed' }).success).toBe(false);
    expect(recordPaymentResultInput.safeParse({ ...base, status: 'redirect', providerRef: 'trade-1' }).success).toBe(false);
    expect(recordPaymentResultInput.safeParse({ ...base, status: 'awaiting_payment', providerRef: 'trade-1', instructions: [{ label: '帳號', value: '123' }] }).success).toBe(false);
    expect(recordPaymentResultInput.safeParse({ ...base, status: 'failed', action: { type: 'redirect', url: 'https://pay.example.test' } }).success).toBe(false);
  });
});
