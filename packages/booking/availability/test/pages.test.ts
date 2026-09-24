import { PlatformError, type Actor } from '@storeweave/contracts';
import type { PageResolveContext } from '@storeweave/kernel';
import { ZodError } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { bookingAvailabilityPages } from '../src/pages';
import type { BookingQuote } from '../src/quote';

const actor: Actor = { id: 'anonymous', type: 'service', displayName: 'visitor', permissions: ['booking-availability:quote'] };
const fingerprint = `booking-quote-v1:test:${'a'.repeat(64)}`;
const quote: BookingQuote = {
  roomTypeId: '81a8ae9d-5096-48b8-8b59-af3c7a14ce02',
  checkInLocalDate: '2026-10-01', checkOutLocalDate: '2026-10-03', adults: 2, children: 0, roomCount: 1,
  currency: 'USD',
  nights: [
    { localDate: '2026-10-01', nightlyPriceMinor: 10_000, nightlyTotalMinor: 10_000 },
    { localDate: '2026-10-02', nightlyPriceMinor: 10_000, nightlyTotalMinor: 10_000 },
  ],
  totalMinor: 20_000,
  cancellationPolicy: { freeCancellationHoursBeforeCheckIn: 24, propertyTimeZone: 'Asia/Taipei', checkInTime: '15:00' },
  fingerprint,
};

function context(execute: ReturnType<typeof vi.fn>): PageResolveContext {
  return {
    queries: { execute }, actor, locale: 'zh-TW', clientKey: 'test',
    commands: { execute: vi.fn() },
    cookies: { guestCartToken: () => null, ensureGuestCart: () => 'unused' },
    providers: { get: vi.fn(), has: vi.fn() },
  };
}

describe('Booking Availability storefront page producers', () => {
  it('renders the untouched Search page as a form without querying', async () => {
    const execute = vi.fn();
    const page = bookingAvailabilityPages.search;
    const outcome = await page.resolve(context(execute), page.input.parse({}));
    expect(outcome).toEqual({ kind: 'view', view: { kind: 'form', values: {
      checkInLocalDate: '', checkOutLocalDate: '', adults: '', children: '', roomCount: '',
    } } });
    expect(execute).not.toHaveBeenCalled();
    expect([page.id, page.path, page.method, page.audience]).toEqual([
      'booking.availability.search', '/booking/search', 'get', 'public',
    ]);
  });

  it('converts public GET count strings and returns available Search choices', async () => {
    const result = { kind: 'available' as const, choices: [{ roomType: { id: quote.roomTypeId, name: '海景房' }, quote }] };
    const execute = vi.fn().mockResolvedValue(result);
    const page = bookingAvailabilityPages.search;
    const input = page.input.parse({
      checkInLocalDate: '2026-10-01', checkOutLocalDate: '2026-10-03', adults: '2', children: '0', roomCount: '1',
    });
    const outcome = await page.resolve(context(execute), input);
    expect(execute).toHaveBeenCalledWith('booking.availability.searchQuotes', {
      checkInLocalDate: '2026-10-01', checkOutLocalDate: '2026-10-03', adults: 2, children: 0, roomCount: 1,
    }, { actor });
    expect(outcome).toEqual({ kind: 'view', view: { kind: 'results', choices: result.choices } });
  });

  it('renders semantic query validation as an HTTP 400 view and lets other failures bubble', async () => {
    const execute = vi.fn();
    const page = bookingAvailabilityPages.search;
    const invalidInput = page.input.parse({ checkInLocalDate: 'not-a-date' });
    const invalid = await page.resolve(context(execute), invalidInput);
    expect(invalid).toMatchObject({ kind: 'view', status: 400, view: { kind: 'validation-error' } });
    expect(execute).not.toHaveBeenCalled();

    const conflict = PlatformError.conflict('Property is not configured');
    execute.mockRejectedValue(conflict);
    const validInput = page.input.parse({
      checkInLocalDate: '2026-10-01', checkOutLocalDate: '2026-10-03', adults: '2', children: '0', roomCount: '1',
    });
    await expect(page.resolve(context(execute), validInput)).rejects.toBe(conflict);

    const downstreamSchemaFailure = new ZodError([{ code: 'custom', path: [], message: 'internal output schema failure' }]);
    execute.mockRejectedValue(downstreamSchemaFailure);
    await expect(page.resolve(context(execute), validInput)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR', message: 'Booking Search query returned invalid data',
    });
  });

  it('classifies Quote fingerprint states with unavailable supply taking precedence', async () => {
    const execute = vi.fn().mockResolvedValue({ kind: 'available', quote });
    const page = bookingAvailabilityPages.quote;
    const makeInput = (expectedFingerprint?: string) => page.input.parse({
      roomTypeId: quote.roomTypeId, checkInLocalDate: quote.checkInLocalDate,
      checkOutLocalDate: quote.checkOutLocalDate, adults: '2', children: '0', roomCount: '1',
      ...(expectedFingerprint === undefined ? {} : { expectedFingerprint }),
    });

    const currentWithoutExpected = await page.resolve(context(execute), makeInput());
    expect(currentWithoutExpected).toEqual({ kind: 'view', view: { kind: 'current', quote } });
    const currentWithExpected = await page.resolve(context(execute), makeInput(fingerprint));
    expect(currentWithExpected).toEqual({ kind: 'view', view: { kind: 'current', quote } });
    const refreshed = await page.resolve(context(execute), makeInput(`booking-quote-v1:test:${'b'.repeat(64)}`));
    expect(refreshed).toEqual({ kind: 'view', view: {
      kind: 'refreshed', quote, expectedFingerprint: `booking-quote-v1:test:${'b'.repeat(64)}`,
    } });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0][0]).toBe('booking.availability.getQuote');
    expect(execute.mock.calls[0][1]).not.toHaveProperty('expectedFingerprint');

    execute.mockResolvedValue({ kind: 'unavailable' });
    await expect(page.resolve(context(execute), makeInput(`booking-quote-v1:test:${'b'.repeat(64)}`)))
      .resolves.toEqual({ kind: 'view', view: { kind: 'unavailable' } });

    const downstreamSchemaFailure = new ZodError([{ code: 'custom', path: [], message: 'internal output schema failure' }]);
    execute.mockRejectedValue(downstreamSchemaFailure);
    await expect(page.resolve(context(execute), makeInput())).rejects.toMatchObject({
      code: 'INTERNAL_ERROR', message: 'Booking Quote query returned invalid data',
    });
  });

  it('turns missing Quote fields and malformed expected fingerprints into typed validation views', async () => {
    const execute = vi.fn();
    const page = bookingAvailabilityPages.quote;
    await expect(page.resolve(context(execute), page.input.parse({})))
      .resolves.toMatchObject({ kind: 'view', status: 400, view: { kind: 'validation-error' } });
    await expect(page.resolve(context(execute), page.input.parse({ expectedFingerprint: 'bad' })))
      .resolves.toMatchObject({ kind: 'view', status: 400, view: { kind: 'validation-error' } });
    expect(execute).not.toHaveBeenCalled();
  });
});
