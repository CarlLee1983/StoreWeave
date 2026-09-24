import { describe, expect, it } from 'vitest';
import {
  getRoomNightRangeInputSchema, isCanonicalLocalDate, localDateRange,
  MAX_ROOM_NIGHTS_PER_UPDATE, setBaseNightlyPriceInputSchema, updateRoomNightRangeInputSchema,
} from '../src/types';

const roomTypeId = 'f231e130-5cdf-4e2e-9d01-4b669aebac3e';

describe('Booking Availability input contracts', () => {
  it('validates Gregorian local dates and expands a half-open calendar range', () => {
    expect(isCanonicalLocalDate('2028-02-29')).toBe(true);
    expect(isCanonicalLocalDate('2027-02-29')).toBe(false);
    expect(isCanonicalLocalDate('2027-2-03')).toBe(false);
    expect(localDateRange('2027-03-13', '2027-03-16')).toEqual(['2027-03-13', '2027-03-14', '2027-03-15']);
    expect(localDateRange('2028-02-28', '2028-03-02')).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
  });

  it('accepts valid base prices and date ranges with explicit patch semantics', () => {
    expect(setBaseNightlyPriceInputSchema.safeParse({ roomTypeId, baseNightlyPriceMinor: 12_345 }).success).toBe(true);
    expect(updateRoomNightRangeInputSchema.safeParse({
      roomTypeId, startLocalDate: '2027-05-01', endLocalDateExclusive: '2027-05-04', sellableUnits: 2,
    }).success).toBe(true);
    expect(updateRoomNightRangeInputSchema.safeParse({
      roomTypeId, startLocalDate: '2027-05-01', endLocalDateExclusive: '2027-05-04', nightlyPriceOverrideMinor: null,
    }).success).toBe(true);
    expect(getRoomNightRangeInputSchema.safeParse({
      roomTypeId, startLocalDate: '2027-05-01', endLocalDateExclusive: '2027-05-04',
    }).success).toBe(true);
  });

  it('rejects invalid dates, empty or reversed ranges, oversized ranges, and negative values', () => {
    expect(isCanonicalLocalDate('2027-04-31')).toBe(false);
    expect(updateRoomNightRangeInputSchema.safeParse({
      roomTypeId, startLocalDate: '2027-05-01', endLocalDateExclusive: '2027-05-01', sellableUnits: 1,
    }).success).toBe(false);
    expect(updateRoomNightRangeInputSchema.safeParse({
      roomTypeId, startLocalDate: '2027-05-04', endLocalDateExclusive: '2027-05-01', sellableUnits: 1,
    }).success).toBe(false);
    expect(updateRoomNightRangeInputSchema.safeParse({
      roomTypeId, startLocalDate: '2027-05-01', endLocalDateExclusive: '2027-05-02',
    }).success).toBe(false);
    expect(updateRoomNightRangeInputSchema.safeParse({
      roomTypeId, startLocalDate: '2027-05-01', endLocalDateExclusive: '2028-05-02', sellableUnits: 1,
    }).success).toBe(false);
    expect(MAX_ROOM_NIGHTS_PER_UPDATE).toBe(366);
    expect(updateRoomNightRangeInputSchema.safeParse({
      roomTypeId, startLocalDate: '2027-05-01', endLocalDateExclusive: '2027-05-02', sellableUnits: -1,
    }).success).toBe(false);
    expect(setBaseNightlyPriceInputSchema.safeParse({ roomTypeId, baseNightlyPriceMinor: -1 }).success).toBe(false);
  });

  it('does not accept caller-supplied reserved units or unknown fields', () => {
    expect(updateRoomNightRangeInputSchema.safeParse({
      roomTypeId, startLocalDate: '2027-05-01', endLocalDateExclusive: '2027-05-02', sellableUnits: 2, reservedUnits: 1,
    }).success).toBe(false);
    expect(setBaseNightlyPriceInputSchema.safeParse({ roomTypeId, baseNightlyPriceMinor: 1, currency: 'USD' }).success).toBe(false);
  });
});
