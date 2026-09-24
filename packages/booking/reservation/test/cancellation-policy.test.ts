import { describe, expect, it } from 'vitest';
import { evaluateReservationCancellationEligibility } from '../src/cancellation-policy';

const policy = { freeCancellationHoursBeforeCheckIn: 48, propertyTimeZone: 'America/Los_Angeles', checkInTime: '15:00' };

describe('Reservation cancellation policy', () => {
  it('uses the frozen Property-local check-in instant and rejects the exact cutoff', () => {
    const input = { checkInLocalDate: '2025-03-10', cancellationPolicy: policy };
    expect(evaluateReservationCancellationEligibility({ ...input, now: new Date('2025-03-08T21:59:59.999Z') }))
      .toMatchObject({ kind: 'eligible', deadline: new Date('2025-03-08T22:00:00.000Z') });
    expect(evaluateReservationCancellationEligibility({ ...input, now: new Date('2025-03-08T22:00:00.000Z') }))
      .toMatchObject({ kind: 'ineligible', deadline: new Date('2025-03-08T22:00:00.000Z') });
  });

  it('rejects invalid zones and nonexistent or ambiguous DST local check-in times', () => {
    const input = { checkInLocalDate: '2025-03-09', now: new Date('2025-03-01T00:00:00.000Z') };
    expect(evaluateReservationCancellationEligibility({ ...input, cancellationPolicy: { ...policy, propertyTimeZone: 'Mars/Olympus_Mons' } }))
      .toEqual({ kind: 'invalid' });
    expect(evaluateReservationCancellationEligibility({ ...input, cancellationPolicy: { ...policy, checkInTime: '02:30' } }))
      .toEqual({ kind: 'invalid' });
    expect(evaluateReservationCancellationEligibility({ ...input, checkInLocalDate: '2025-11-02', cancellationPolicy: { ...policy, checkInTime: '01:30' } }))
      .toEqual({ kind: 'invalid' });
  });

  it('uses UTC policies without host-time-zone dependence', () => {
    expect(evaluateReservationCancellationEligibility({
      checkInLocalDate: '2025-01-02',
      cancellationPolicy: { freeCancellationHoursBeforeCheckIn: 0, propertyTimeZone: 'UTC', checkInTime: '00:00' },
      now: new Date('2025-01-01T23:59:59.999Z'),
    })).toMatchObject({ kind: 'eligible', deadline: new Date('2025-01-02T00:00:00.000Z') });
  });
});
