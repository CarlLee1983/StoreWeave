import { PlatformError, defineQuery, type DrizzleDb, type Tx, type QueryContext } from '@storeweave/contracts';
import { z } from 'zod';
import { BookingAvailabilityRepository } from './repository';
import {
  assertQuoteSigningKeyring, bookingQuoteLimitsSchema, bookingQuoteSchema, bookingStayInputSchema, makeQuote,
  roomTypeEligibilityError, staticStayValidation, validatePropertyHorizon,
  type BookingQuote, type BookingStayRequest, type QuoteSnapshotRepository,
} from './quote';
import type { Keyring } from '@storeweave/crypto';
import type { BookingPropertyLookup } from './types';

export const bookingSearchInputSchema = bookingStayInputSchema;

const bookingSearchChoiceSchema = z.object({
  roomType: z.object({ id: z.string().uuid(), name: z.string() }).strict(),
  quote: bookingQuoteSchema,
}).strict();

export const bookingSearchResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('available'), choices: z.array(bookingSearchChoiceSchema).min(1) }).strict(),
  z.object({ kind: z.literal('unavailable') }).strict(),
]);

export type BookingSearchInput = z.infer<typeof bookingSearchInputSchema>;
export type BookingSearchChoice = { readonly roomType: { readonly id: string; readonly name: string }; readonly quote: BookingQuote };
export type BookingSearchResult = z.infer<typeof bookingSearchResultSchema>;

export interface BookingAvailabilitySearchCapability {
  search(db: DrizzleDb | Tx, input: BookingSearchInput, now: Date): Promise<BookingSearchResult>;
}

const defaultRepository = new BookingAvailabilityRepository();

export function createBookingAvailabilitySearch(
  properties: BookingPropertyLookup,
  limits: { readonly maxRoomsPerRequest: number },
  keyring: Keyring,
  repository: QuoteSnapshotRepository = defaultRepository,
): BookingAvailabilitySearchCapability {
  const parsedLimits = bookingQuoteLimitsSchema.safeParse(limits);
  if (!parsedLimits.success) throw new TypeError(`Invalid Booking Availability Search limits: ${parsedLimits.error.message}`);
  assertQuoteSigningKeyring(keyring);

  return Object.freeze({
    async search(db: DrizzleDb | Tx, rawInput: BookingSearchInput, now: Date): Promise<BookingSearchResult> {
      const parsedInput = bookingSearchInputSchema.safeParse(rawInput);
      if (!parsedInput.success) throw PlatformError.validation('Invalid Booking Search input', parsedInput.error.issues);
      if (!Number.isFinite(now.getTime())) throw PlatformError.validation('Search clock must be a valid date');

      const input: BookingStayRequest = parsedInput.data;
      const nightCount = staticStayValidation(input, parsedLimits.data.maxRoomsPerRequest);
      const property = await properties.getProperty(db);
      if (!property) throw PlatformError.conflict('Booking Property is not configured');
      const roomTypes = await properties.listActiveRoomTypes(db);
      validatePropertyHorizon(input, property, now);

      const cancellationPolicy = {
        freeCancellationHoursBeforeCheckIn: property.defaultPolicy.freeCancellationHoursBeforeCheckIn,
        propertyTimeZone: property.timezone,
        checkInTime: property.checkInTime,
      };

      const choices = (await Promise.all(roomTypes.map(async roomType => {
        if (roomTypeEligibilityError(input, nightCount, roomType)) return null;
        const quoteInput = { ...input, roomTypeId: roomType.id };
        const snapshot = await repository.loadQuoteSnapshot(
          db, roomType.id, input.checkInLocalDate, input.checkOutLocalDate,
        );
        const result = makeQuote(
          quoteInput, property.id, property.currency, cancellationPolicy, snapshot, nightCount, keyring,
        );
        return result.kind === 'available' ? { roomType: { id: roomType.id, name: roomType.name }, quote: result.quote } : null;
      }))).filter((choice): choice is BookingSearchChoice => choice !== null);

      return choices.length > 0 ? { kind: 'available', choices } : { kind: 'unavailable' };
    },
  });
}

export const searchBookingQuotesQuery = defineQuery({
  name: 'booking.availability.searchQuotes',
  summary: '依目前可預訂房型與供應搜尋 Booking Quotes',
  input: bookingSearchInputSchema,
  output: bookingSearchResultSchema,
  permission: 'booking-availability:quote',
});

export function createSearchBookingQuotesHandler(search: BookingAvailabilitySearchCapability) {
  return (input: BookingSearchInput, context: QueryContext) => search.search(context.db, input, context.now);
}
