import { describe, expect, it } from 'vitest';
import { evaluateReservationRetentionEligibility } from '../src/retention-date';

describe('Reservation retention date eligibility', () => {
  it('uses an inclusive Property-local date cutoff across year boundaries', () => {
    expect(evaluateReservationRetentionEligibility({
      checkOutLocalDate: '2024-12-31',
      propertyTimeZone: 'UTC',
      reservationPiiRetentionDays: 1,
      now: new Date('2025-01-01T12:00:00.000Z'),
    })).toEqual({ kind: 'eligible', eligibleOnLocalDate: '2025-01-01' });
  });

  it('uses the Property-local calendar date rather than the UTC date', () => {
    const instant = new Date('2025-01-01T02:00:00.000Z');
    const cutoff = {
      checkOutLocalDate: '2024-12-31',
      reservationPiiRetentionDays: 1,
      now: instant,
    };

    expect(evaluateReservationRetentionEligibility({ ...cutoff, propertyTimeZone: 'Pacific/Kiritimati' }))
      .toEqual({ kind: 'eligible', eligibleOnLocalDate: '2025-01-01' });
    expect(evaluateReservationRetentionEligibility({ ...cutoff, propertyTimeZone: 'Pacific/Pago_Pago' }))
      .toEqual({ kind: 'ineligible' });
  });

  it('adds calendar days across a daylight-saving transition', () => {
    const input = {
      checkOutLocalDate: '2025-03-08',
      propertyTimeZone: 'America/Los_Angeles',
      reservationPiiRetentionDays: 1,
    };

    expect(evaluateReservationRetentionEligibility({
      ...input, now: new Date('2025-03-09T07:59:59.999Z'),
    })).toEqual({ kind: 'ineligible' });
    expect(evaluateReservationRetentionEligibility({
      ...input, now: new Date('2025-03-09T08:00:00.000Z'),
    })).toEqual({ kind: 'eligible', eligibleOnLocalDate: '2025-03-09' });
  });

  it('handles leap days and rejects invalid persisted facts safely', () => {
    expect(evaluateReservationRetentionEligibility({
      checkOutLocalDate: '2024-02-28',
      propertyTimeZone: 'UTC',
      reservationPiiRetentionDays: 1,
      now: new Date('2024-02-29T12:00:00.000Z'),
    })).toEqual({ kind: 'eligible', eligibleOnLocalDate: '2024-02-29' });

    const input = {
      checkOutLocalDate: '2025-01-01',
      propertyTimeZone: 'UTC',
      reservationPiiRetentionDays: 1,
      now: new Date('2025-01-03T12:00:00.000Z'),
    };
    expect(evaluateReservationRetentionEligibility({ ...input, checkOutLocalDate: '2025-02-30' })).toEqual({ kind: 'invalid' });
    expect(evaluateReservationRetentionEligibility({ ...input, propertyTimeZone: 'Mars/Olympus_Mons' })).toEqual({ kind: 'invalid' });
    expect(evaluateReservationRetentionEligibility({ ...input, now: new Date(Number.NaN) })).toEqual({ kind: 'invalid' });
    expect(evaluateReservationRetentionEligibility({ ...input, reservationPiiRetentionDays: 0 })).toEqual({ kind: 'invalid' });
    expect(evaluateReservationRetentionEligibility({ ...input, reservationPiiRetentionDays: Number.MAX_SAFE_INTEGER }))
      .toEqual({ kind: 'ineligible' });
    expect(evaluateReservationRetentionEligibility({ ...input, reservationPiiRetentionDays: Number.MAX_SAFE_INTEGER + 1 }))
      .toEqual({ kind: 'invalid' });
    expect(evaluateReservationRetentionEligibility({
      checkOutLocalDate: '9999-12-31',
      propertyTimeZone: 'UTC',
      reservationPiiRetentionDays: 1,
      now: new Date('9999-12-31T12:00:00.000Z'),
    })).toEqual({ kind: 'ineligible' });
  });
});
