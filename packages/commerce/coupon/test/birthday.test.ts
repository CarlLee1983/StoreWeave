import { describe, expect, it } from 'vitest';
import { birthdayMonthDaysFor, storeDateParts } from '@storeweave/coupon';

/** 生日禮券的日期判斷（工單 35）。 */

const TAIPEI = 'Asia/Taipei';

describe('店鋪時區的今天', () => {
  it('台北時間的當天，而不是 UTC 的當天', () => {
    // UTC 8/21 16:30 已經是台北的 8/22 凌晨。
    expect(storeDateParts(new Date('2026-08-21T16:30:00.000Z'), TAIPEI))
      .toEqual({ year: '2026', monthDay: '08-22' });
    // UTC 8/21 15:30 還是台北的 8/21 深夜。
    expect(storeDateParts(new Date('2026-08-21T15:30:00.000Z'), TAIPEI))
      .toEqual({ year: '2026', monthDay: '08-21' });
  });

  it('換一個時區就是另一天', () => {
    expect(storeDateParts(new Date('2026-08-21T16:30:00.000Z'), 'UTC').monthDay).toBe('08-21');
  });
});

describe('今天該發給哪些月日', () => {
  it('平常就是今天那一個', () => {
    expect(birthdayMonthDaysFor(new Date('2026-08-22T02:00:00.000Z'), TAIPEI)).toEqual(['08-22']);
  });

  it('平年的三月一日順便發給二月二十九日的壽星', () => {
    expect(birthdayMonthDaysFor(new Date('2026-03-01T02:00:00.000Z'), TAIPEI)).toEqual(['03-01', '02-29']);
  });

  it('閏年的三月一日不必順便發——那些人二月二十九日已經收過了', () => {
    expect(birthdayMonthDaysFor(new Date('2028-03-01T02:00:00.000Z'), TAIPEI)).toEqual(['03-01']);
    expect(birthdayMonthDaysFor(new Date('2028-02-29T02:00:00.000Z'), TAIPEI)).toEqual(['02-29']);
  });

  it('世紀年的規則也要對：2100 不是閏年，2000 是', () => {
    expect(birthdayMonthDaysFor(new Date('2100-03-01T02:00:00.000Z'), TAIPEI)).toEqual(['03-01', '02-29']);
    expect(birthdayMonthDaysFor(new Date('2000-03-01T02:00:00.000Z'), TAIPEI)).toEqual(['03-01']);
  });
});
