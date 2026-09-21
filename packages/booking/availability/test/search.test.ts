import type { DrizzleDb } from '@storeweave/contracts';
import { createKeyring } from '@storeweave/crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBookingAvailabilitySearch, type BookingSearchInput } from '../src/search';
import type { BookingPropertyLookup } from '../src/types';

const now = new Date('2026-09-20T12:00:00.000Z');
const db = {} as DrizzleDb;
const keyring = createKeyring({ activeKeyId: 'test', keys: [{ id: 'test', secret: Buffer.alloc(32, 9).toString('base64url') }] });
const property = {
  id: '3e0bcf3b-0f44-4696-a5b7-e9fbeb91d230', timezone: 'Pacific/Kiritimati', currency: 'USD', checkInTime: '15:00',
  defaultPolicy: { freeCancellationHoursBeforeCheckIn: 48 },
};
const ids = {
  first: '81a8ae9d-5096-48b8-8b59-af3c7a14ce02',
  tooShort: '82a8ae9d-5096-48b8-8b59-af3c7a14ce02',
  tooSmall: '83a8ae9d-5096-48b8-8b59-af3c7a14ce02',
  soldOut: '84a8ae9d-5096-48b8-8b59-af3c7a14ce02',
  last: '85a8ae9d-5096-48b8-8b59-af3c7a14ce02',
};

function addDays(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day + days);
  date.setUTCHours(0, 0, 0, 0);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

const inputFor = (checkInLocalDate: string, values: Partial<BookingSearchInput> = {}): BookingSearchInput => ({
  checkInLocalDate,
  checkOutLocalDate: addDays(checkInLocalDate, 2),
  adults: 2,
  children: 0,
  roomCount: 1,
  ...values,
});

describe('Booking Availability Search', () => {
  let properties: BookingPropertyLookup;
  let repository: { loadQuoteSnapshot: ReturnType<typeof vi.fn> };
  const today = localDate(now, property.timezone);
  const checkIn = addDays(today, 10);
  const dates = [checkIn, addDays(checkIn, 1)];
  const roomTypes = [
    { id: ids.first, name: '海景房', maxOccupancyPerUnit: 2, minimumStayNights: 1, maximumStayNights: null },
    { id: ids.tooShort, name: '長住房', maxOccupancyPerUnit: 2, minimumStayNights: 3, maximumStayNights: null },
    { id: ids.tooSmall, name: '單人房', maxOccupancyPerUnit: 1, minimumStayNights: 1, maximumStayNights: null },
    { id: ids.soldOut, name: '客滿房', maxOccupancyPerUnit: 2, minimumStayNights: 1, maximumStayNights: null },
    { id: ids.last, name: '庭園房', maxOccupancyPerUnit: 2, minimumStayNights: 1, maximumStayNights: null },
  ];

  beforeEach(() => {
    properties = {
      getProperty: vi.fn().mockResolvedValue(property),
      getActiveRoomType: vi.fn().mockResolvedValue(roomTypes[0]),
      listActiveRoomTypes: vi.fn().mockResolvedValue(roomTypes),
    };
    repository = {
      loadQuoteSnapshot: vi.fn().mockImplementation(async (_db: unknown, roomTypeId: string) => {
        const available = roomTypeId !== ids.soldOut;
        return dates.map((localDate, index) => ({
          baseNightlyPriceMinor: roomTypeId === ids.last ? 11_000 : 10_000,
          localDate,
          sellableUnits: available ? 2 : 1,
          reservedUnits: available ? 0 : 1,
          nightlyPriceOverrideMinor: index === 1 ? 12_000 : null,
        }));
      }),
    };
  });

  it('validates common static constraints before owner or Availability reads', async () => {
    const search = createBookingAvailabilitySearch(properties, { maxRoomsPerRequest: 3 }, keyring, repository);
    await expect(search.search(db, inputFor(checkIn, { adults: 0 }), now)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(search.search(db, inputFor('2026-02-30'), now)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(search.search(db, inputFor(checkIn, { checkOutLocalDate: addDays(checkIn, 31) }), now))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(properties.getProperty).not.toHaveBeenCalled();
    expect(properties.listActiveRoomTypes).not.toHaveBeenCalled();
    expect(repository.loadQuoteSnapshot).not.toHaveBeenCalled();
  });

  it('reads Property facts once, filters only room-specific mismatches or unavailable supply, and preserves Property order', async () => {
    const search = createBookingAvailabilitySearch(properties, { maxRoomsPerRequest: 3 }, keyring, repository);
    const result = await search.search(db, inputFor(checkIn), now);
    expect(result.kind).toBe('available');
    if (result.kind !== 'available') throw new Error('Expected available search choices');
    expect(result.choices.map(choice => choice.roomType)).toEqual([
      { id: ids.first, name: '海景房' }, { id: ids.last, name: '庭園房' },
    ]);
    expect(result.choices[0].quote.nights).toMatchObject([
      { localDate: checkIn, nightlyPriceMinor: 10_000, nightlyTotalMinor: 10_000 },
      { localDate: addDays(checkIn, 1), nightlyPriceMinor: 12_000, nightlyTotalMinor: 12_000 },
    ]);
    expect(properties.getProperty).toHaveBeenCalledTimes(1);
    expect(properties.listActiveRoomTypes).toHaveBeenCalledTimes(1);
    expect(repository.loadQuoteSnapshot.mock.calls.map((call: unknown[]) => call[1])).toEqual([ids.first, ids.soldOut, ids.last]);
  });

  it('checks the Property-local horizon before any Availability supply reads', async () => {
    const search = createBookingAvailabilitySearch(properties, { maxRoomsPerRequest: 3 }, keyring, repository);
    const tooFar = inputFor(addDays(today, 366));
    await expect(search.search(db, tooFar, now)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(properties.getProperty).toHaveBeenCalledTimes(1);
    expect(properties.listActiveRoomTypes).toHaveBeenCalledTimes(1);
    expect(repository.loadQuoteSnapshot).not.toHaveBeenCalled();
  });

  it('surfaces an eligible Room Type missing its base price as a configuration conflict', async () => {
    vi.mocked(properties.listActiveRoomTypes).mockResolvedValue([roomTypes[0]]);
    repository.loadQuoteSnapshot.mockResolvedValue([]);
    const search = createBookingAvailabilitySearch(properties, { maxRoomsPerRequest: 3 }, keyring, repository);
    await expect(search.search(db, inputFor(checkIn), now)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
