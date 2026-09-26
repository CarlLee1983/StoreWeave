import { describe, expect, it } from 'vitest';
import { reconcileBookingReservationRefundsJobPayload } from '../src/jobs';

describe('refund reconciliation v1 payload compatibility', () => {
  it('preserves queued empty payloads and accepts complete interval occurrences', () => {
    expect(reconcileBookingReservationRefundsJobPayload.parse({})).toEqual({});
    const occurrence = { bucket: 492912, scheduledFor: '2026-03-26T00:00:00.000Z' };
    expect(reconcileBookingReservationRefundsJobPayload.parse(occurrence)).toEqual(occurrence);
  });

  it.each([
    { bucket: 1 }, { scheduledFor: '2026-03-26T00:00:00.000Z' },
    { bucket: 1.5, scheduledFor: '2026-03-26T00:00:00.000Z' },
    { bucket: 1, scheduledFor: 'invalid' },
    { bucket: 1, scheduledFor: '2026-03-26T00:00:00.000Z', refundId: 'untrusted' },
    { refundId: 'untrusted' },
  ])('rejects malformed or undeclared job fields: %j', payload => {
    expect(reconcileBookingReservationRefundsJobPayload.safeParse(payload).success).toBe(false);
  });
});
