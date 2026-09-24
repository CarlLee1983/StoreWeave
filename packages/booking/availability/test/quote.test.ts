import type { DrizzleDb } from '@storeweave/contracts';
import { createKeyring, type Keyring } from '@storeweave/crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBookingAvailabilityQuote, type BookingQuoteInput } from '../src/quote';
import type { BookingPropertyLookup } from '../src/types';

const now = new Date('2026-09-20T12:00:00.000Z');
const db = {} as DrizzleDb;
const quoteKeyring = (fill: number) => createKeyring({
  activeKeyId: 'test',
  keys: [{ id: 'test', secret: Buffer.alloc(32, fill).toString('base64url') }],
});

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

const roomTypeId = '81a8ae9d-5096-48b8-8b59-af3c7a14ce02';
const inputFor = (checkInLocalDate: string, values: Partial<BookingQuoteInput> = {}): BookingQuoteInput => ({
  roomTypeId,
  checkInLocalDate,
  checkOutLocalDate: addDays(checkInLocalDate, 2),
  adults: 2,
  children: 1,
  roomCount: 2,
  ...values,
});

describe('Booking Availability Quote contract', () => {
  const property = {
    id: '3e0bcf3b-0f44-4696-a5b7-e9fbeb91d230',
    timezone: 'Pacific/Kiritimati',
    currency: 'USD',
    checkInTime: '15:00',
    defaultPolicy: { freeCancellationHoursBeforeCheckIn: 48 },
  };
  const roomType = { id: roomTypeId, maxOccupancyPerUnit: 2, minimumStayNights: 1, maximumStayNights: null };
  let properties: BookingPropertyLookup;
  let repository: { loadQuoteSnapshot: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    properties = {
      getProperty: vi.fn().mockResolvedValue(property),
      getActiveRoomType: vi.fn().mockResolvedValue(roomType),
      listActiveRoomTypes: vi.fn().mockResolvedValue([]),
    };
    repository = {
      loadQuoteSnapshot: vi.fn().mockResolvedValue([{
        baseNightlyPriceMinor: 10_000, localDate: null, sellableUnits: null, reservedUnits: null,
        nightlyPriceOverrideMinor: null,
      }]),
    };
  });

  it('rejects request-only invalidity before Property reads or Availability queries', async () => {
    const quote = createBookingAvailabilityQuote(properties, { maxRoomsPerRequest: 3 }, quoteKeyring(1), repository);
    const checkIn = addDays(localDate(now, property.timezone), 10);
    const cases = [
      inputFor(checkIn, { adults: 1, roomCount: 2 }),
      inputFor(checkIn, { roomCount: 4 }),
      inputFor(checkIn, { checkOutLocalDate: addDays(checkIn, 31) }),
      inputFor(checkIn, { checkOutLocalDate: checkIn }),
      { ...inputFor(checkIn), roomTypeId: 'not-a-uuid' },
      { ...inputFor(checkIn), checkInLocalDate: '2026-02-30' },
      inputFor(checkIn, { adults: -1 }),
      inputFor(checkIn, { roomCount: 0 }),
    ];

    for (const input of cases) await expect(quote.quote(db, input, now)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(properties.getProperty).not.toHaveBeenCalled();
    expect(properties.getActiveRoomType).not.toHaveBeenCalled();
    expect(repository.loadQuoteSnapshot).not.toHaveBeenCalled();
  });

  it('requires a valid injected room-count cap instead of inventing a package default', () => {
    expect(() => createBookingAvailabilityQuote(properties, { maxRoomsPerRequest: 0 }, quoteKeyring(1), repository)).toThrow(/Invalid Booking Availability Quote limits/);
    expect(() => createBookingAvailabilityQuote(properties, {} as { maxRoomsPerRequest: number }, quoteKeyring(1), repository)).toThrow(/Invalid Booking Availability Quote limits/);
    expect(() => createBookingAvailabilityQuote(properties, { maxRoomsPerRequest: 3 }, undefined as unknown as Keyring, repository))
      .toThrow(/requires a configured signing Keyring/);
  });

  it('accepts the 30-night limit and the inclusive Property-local +365-day check-in boundary', async () => {
    const quote = createBookingAvailabilityQuote(properties, { maxRoomsPerRequest: 3 }, quoteKeyring(1), repository);
    const today = localDate(now, property.timezone);
    const checkIn = addDays(today, 1);
    const thirtyNightStay = inputFor(checkIn, { checkOutLocalDate: addDays(checkIn, 30) });
    await expect(quote.quote(db, thirtyNightStay, now)).resolves.toEqual({ kind: 'unavailable' });
    expect(repository.loadQuoteSnapshot).toHaveBeenCalledTimes(1);

    repository.loadQuoteSnapshot.mockClear();
    const lastAllowedCheckIn = inputFor(addDays(today, 365), {
      checkOutLocalDate: addDays(today, 366), roomCount: 1, adults: 1, children: 0,
    });
    await expect(quote.quote(db, lastAllowedCheckIn, now)).resolves.toEqual({ kind: 'unavailable' });
    expect(repository.loadQuoteSnapshot).toHaveBeenCalledTimes(1);

    repository.loadQuoteSnapshot.mockClear();
    const firstDisallowedCheckIn = inputFor(addDays(today, 366), {
      checkOutLocalDate: addDays(today, 367), roomCount: 1, adults: 1, children: 0,
    });
    await expect(quote.quote(db, firstDisallowedCheckIn, now)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(repository.loadQuoteSnapshot).not.toHaveBeenCalled();
  });

  it('checks Property-local horizon, Room Type stay limits, and occupancy before reading Availability', async () => {
    const quote = createBookingAvailabilityQuote(properties, { maxRoomsPerRequest: 3 }, quoteKeyring(1), repository);
    const today = localDate(now, property.timezone);
    const beforeToday = inputFor(addDays(today, -1));
    await expect(quote.quote(db, beforeToday, now)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(repository.loadQuoteSnapshot).not.toHaveBeenCalled();

    vi.mocked(properties.getProperty).mockClear();
    vi.mocked(properties.getActiveRoomType).mockClear();
    vi.mocked(properties.getActiveRoomType).mockResolvedValue({ ...roomType, maxOccupancyPerUnit: 2, minimumStayNights: 3 });
    await expect(quote.quote(db, inputFor(addDays(today, 1)), now)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(properties.getProperty).toHaveBeenCalledTimes(1);
    expect(properties.getActiveRoomType).toHaveBeenCalledTimes(1);
    expect(repository.loadQuoteSnapshot).not.toHaveBeenCalled();

    vi.mocked(properties.getActiveRoomType).mockResolvedValue({ ...roomType, maximumStayNights: 1 });
    await expect(quote.quote(db, inputFor(addDays(today, 1)), now)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(repository.loadQuoteSnapshot).not.toHaveBeenCalled();

    vi.mocked(properties.getActiveRoomType).mockResolvedValue(roomType);
    await expect(quote.quote(db, inputFor(addDays(today, 1), { adults: 2, children: 3, roomCount: 2 }), now))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(repository.loadQuoteSnapshot).not.toHaveBeenCalled();
  });

  it('distinguishes unavailable Room Nights from missing Property, Room Type, and base-price configuration', async () => {
    const quote = createBookingAvailabilityQuote(properties, { maxRoomsPerRequest: 3 }, quoteKeyring(1), repository);
    const checkIn = addDays(localDate(now, property.timezone), 10);
    await expect(quote.quote(db, inputFor(checkIn), now)).resolves.toEqual({ kind: 'unavailable' });
    repository.loadQuoteSnapshot.mockClear();

    vi.mocked(properties.getProperty).mockResolvedValue(null);
    await expect(quote.quote(db, inputFor(checkIn), now)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(repository.loadQuoteSnapshot).not.toHaveBeenCalled();

    vi.mocked(properties.getProperty).mockResolvedValue(property);
    vi.mocked(properties.getActiveRoomType).mockResolvedValue(null);
    await expect(quote.quote(db, inputFor(checkIn), now)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(repository.loadQuoteSnapshot).not.toHaveBeenCalled();

    vi.mocked(properties.getActiveRoomType).mockResolvedValue(roomType);
    repository.loadQuoteSnapshot.mockResolvedValue([]);
    await expect(quote.quote(db, inputFor(checkIn), now)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('returns unavailable for a missing stay night and rejects totals outside the safe integer range', async () => {
    const quote = createBookingAvailabilityQuote(properties, { maxRoomsPerRequest: 3 }, quoteKeyring(1), repository);
    const checkIn = addDays(localDate(now, property.timezone), 10);
    const input = inputFor(checkIn, { adults: 1, children: 0, roomCount: 1 });
    repository.loadQuoteSnapshot.mockResolvedValue([{
      baseNightlyPriceMinor: 10_000, localDate: checkIn, sellableUnits: 2, reservedUnits: 0,
      nightlyPriceOverrideMinor: null,
    }]);
    await expect(quote.quote(db, input, now)).resolves.toEqual({ kind: 'unavailable' });

    repository.loadQuoteSnapshot.mockResolvedValue([
      { baseNightlyPriceMinor: Number.MAX_SAFE_INTEGER, localDate: checkIn, sellableUnits: 2, reservedUnits: 0, nightlyPriceOverrideMinor: null },
      { baseNightlyPriceMinor: Number.MAX_SAFE_INTEGER, localDate: addDays(checkIn, 1), sellableUnits: 2, reservedUnits: 0, nightlyPriceOverrideMinor: null },
    ]);
    await expect(quote.quote(db, input, now)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('fingerprints prices, room availability, and policy deterministically without exposing stock counts', async () => {
    const quote = createBookingAvailabilityQuote(properties, { maxRoomsPerRequest: 3 }, quoteKeyring(1), repository);
    const checkIn = addDays(localDate(now, property.timezone), 10);
    const input = inputFor(checkIn);
    const rows = [
      { baseNightlyPriceMinor: 12_345, localDate: checkIn, sellableUnits: 4, reservedUnits: 1, nightlyPriceOverrideMinor: null },
      { baseNightlyPriceMinor: 12_345, localDate: addDays(checkIn, 1), sellableUnits: 4, reservedUnits: 1, nightlyPriceOverrideMinor: 20_000 },
    ];
    repository.loadQuoteSnapshot.mockResolvedValue(rows);
    const first = await quote.quote(db, input, now);
    const repeated = await quote.quote(db, input, now);
    expect(first).toEqual(repeated);
    expect(first).toMatchObject({
      kind: 'available',
      quote: {
        currency: 'USD', totalMinor: 64_690,
        nights: [
          { localDate: checkIn, nightlyPriceMinor: 12_345, nightlyTotalMinor: 24_690 },
          { localDate: addDays(checkIn, 1), nightlyPriceMinor: 20_000, nightlyTotalMinor: 40_000 },
        ],
        cancellationPolicy: {
          freeCancellationHoursBeforeCheckIn: 48, propertyTimeZone: property.timezone, checkInTime: '15:00',
        },
        fingerprint: expect.stringMatching(/^booking-quote-v1:test:[0-9a-f]{64}$/),
      },
    });
    expect(JSON.stringify(first)).not.toContain('availableUnits');
    if (first.kind !== 'available') throw new Error('Expected an available Quote');

    repository.loadQuoteSnapshot.mockResolvedValue(rows.map(row => ({ ...row, sellableUnits: 5 })));
    const changedSupply = await quote.quote(db, input, now);
    if (changedSupply.kind !== 'available') throw new Error('Expected an available Quote');
    expect(changedSupply.quote.fingerprint).not.toBe(first.quote.fingerprint);

    vi.mocked(properties.getProperty).mockResolvedValue({ ...property, defaultPolicy: { freeCancellationHoursBeforeCheckIn: 24 } });
    const changedPolicy = await quote.quote(db, input, now);
    if (changedPolicy.kind !== 'available') throw new Error('Expected an available Quote');
    expect(changedPolicy.quote.fingerprint).not.toBe(first.quote.fingerprint);

    const otherKeyQuote = await createBookingAvailabilityQuote(
      properties, { maxRoomsPerRequest: 3 }, quoteKeyring(2), repository,
    ).quote(db, input, now);
    if (otherKeyQuote.kind !== 'available') throw new Error('Expected an available Quote');
    expect(otherKeyQuote.quote.fingerprint).not.toBe(changedPolicy.quote.fingerprint);
  });
});
