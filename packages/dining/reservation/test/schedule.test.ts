import { describe, expect, it } from 'vitest';
import { isWithinBookingWindow, offeredStartTimes, resolveLocalStart } from '../src/schedule.js';

describe('resolveLocalStart', () => {
  it('resolves an ordinary local time to its UTC instant', () => {
    expect(resolveLocalStart('2026-09-28', '18:00', 'Asia/Taipei')?.toISOString())
      .toBe('2026-09-28T10:00:00.000Z');
  });

  it('excludes the spring DST gap and fall DST overlap', () => {
    expect(resolveLocalStart('2026-03-08', '02:30', 'America/New_York')).toBeUndefined();
    expect(resolveLocalStart('2026-11-01', '01:30', 'America/New_York')).toBeUndefined();
    expect(resolveLocalStart('2026-11-01', '02:30', 'America/New_York')?.toISOString())
      .toBe('2026-11-01T07:30:00.000Z');
    expect(resolveLocalStart('2026-10-04', '02:15', 'Australia/Lord_Howe')).toBeUndefined();
    expect(resolveLocalStart('2026-04-05', '01:45', 'Australia/Lord_Howe')).toBeUndefined();
  });

  it('rejects invalid dates, times, and timezone identifiers', () => {
    expect(() => resolveLocalStart('2026-02-30', '18:00', 'UTC')).toThrow(RangeError);
    expect(() => resolveLocalStart('2026-09-28', '24:00', 'UTC')).toThrow(RangeError);
    expect(() => resolveLocalStart('2026-09-28', '18:00', 'PST')).toThrow(RangeError);
    expect(() => resolveLocalStart('2026-09-28', '18:00', 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('offeredStartTimes', () => {
  const weekly = [
    { weekday: 1, startTimes: ['23:30', '18:00'] },
    { weekday: 2, startTimes: ['12:00'] },
  ];

  it('keeps a cross-midnight start on its start date', () => {
    expect(offeredStartTimes('2026-09-28', weekly, [{ date: '2026-09-29', startTimes: [] }]))
      .toEqual(['18:00', '23:30']);
  });

  it('replaces weekly times for a date, including a closed date', () => {
    expect(offeredStartTimes('2026-09-28', weekly, [{ date: '2026-09-28', startTimes: ['20:00'] }]))
      .toEqual(['20:00']);
    expect(offeredStartTimes('2026-09-28', weekly, [{ date: '2026-09-28', startTimes: [] }]))
      .toEqual([]);
    expect(offeredStartTimes('2026-09-29', weekly, [])).toEqual(['12:00']);
  });

  it('rejects malformed schedule data', () => {
    expect(() => offeredStartTimes('2026-09-28', [{ weekday: 7, startTimes: [] }], [])).toThrow(RangeError);
    expect(() => offeredStartTimes('2026-09-28', [{ weekday: 1, startTimes: ['18:00', '18:00'] }], []))
      .toThrow(RangeError);
    expect(() => offeredStartTimes('2026-09-28', weekly, [{ date: '2026-02-30', startTimes: [] }]))
      .toThrow(RangeError);
  });
});

describe('isWithinBookingWindow', () => {
  const now = new Date('2026-09-28T10:00:00.000Z');

  it('includes the default 60-minute and 30-day bounds', () => {
    expect(isWithinBookingWindow(new Date(now.getTime() + 60 * 60_000), now)).toBe(true);
    expect(isWithinBookingWindow(new Date(now.getTime() + 60 * 60_000 - 1), now)).toBe(false);
    expect(isWithinBookingWindow(new Date(now.getTime() + 30 * 24 * 60 * 60_000), now)).toBe(true);
    expect(isWithinBookingWindow(new Date(now.getTime() + 30 * 24 * 60 * 60_000 + 1), now)).toBe(false);
  });

  it('uses configured positive bounds', () => {
    const limits = { minAdvanceMinutes: 120, maxAdvanceDays: 2 };
    expect(isWithinBookingWindow(new Date(now.getTime() + 119 * 60_000), now, limits)).toBe(false);
    expect(isWithinBookingWindow(new Date(now.getTime() + 120 * 60_000), now, limits)).toBe(true);
    expect(isWithinBookingWindow(new Date(now.getTime() + 2 * 24 * 60 * 60_000 + 1), now, limits)).toBe(false);
    expect(() => isWithinBookingWindow(now, now, { minAdvanceMinutes: 0 })).toThrow(RangeError);
    expect(() => isWithinBookingWindow(now, now, { maxAdvanceDays: -1 })).toThrow(RangeError);
  });
});
