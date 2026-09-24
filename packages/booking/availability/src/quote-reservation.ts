import { constantTimeEquals, type Keyring } from '@storeweave/crypto';
import { PlatformError, type Tx } from '@storeweave/contracts';
import { z } from 'zod';
import { BookingAvailabilityRepository } from './repository';
import {
  assertQuoteSigningKeyring, bookingQuoteFingerprintForKey, bookingQuoteFingerprintTerms,
  bookingQuoteInputSchema, bookingQuoteSchema, bookingQuoteLimitsSchema, makeQuote, roomTypeEligibilityError,
  staticStayValidation, validatePropertyHorizon, type BookingQuote, type BookingQuoteInput, type BookingQuoteLimits,
} from './quote';
import { localDateRange, type BookingPropertyLockedQuoteFactsLookup } from './types';

export const BOOKING_AVAILABILITY_QUOTE_RESERVATION_CAPABILITY = 'booking.availability.quote-reservation.v1';

const fingerprintPattern = /^booking-quote-v1:([a-z][a-z0-9-]{0,63}):([0-9a-f]{64})$/;
const reservationClockSchema = z.date().refine(value => Number.isFinite(value.getTime()), 'Expected a valid date');

export const bookingQuoteReservationResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reserved'), quote: bookingQuoteSchema }).strict(),
  z.object({ kind: z.literal('stale'), replacementQuote: bookingQuoteSchema }).strict(),
  z.object({ kind: z.literal('unavailable') }).strict(),
]);

export type BookingQuoteReservationResult =
  | { readonly kind: 'reserved'; readonly quote: BookingQuote }
  | { readonly kind: 'stale'; readonly replacementQuote: BookingQuote }
  | { readonly kind: 'unavailable' };

export interface BookingAvailabilityQuoteReservation {
  revalidateAndReserve(
    tx: Tx,
    request: BookingQuoteInput,
    expectedFingerprint: string,
    now: Date,
  ): Promise<BookingQuoteReservationResult>;
}

type QuoteReservationRepository = Pick<BookingAvailabilityRepository,
  'lockBasePrice' | 'materializeRoomNightsInDateOrder' | 'lockRoomNights' | 'adjustReservedUnits'>;

function validation(message: string, details?: unknown): never {
  throw PlatformError.validation(message, details);
}

function parseFingerprint(value: string): { keyId: string; mac: string } {
  if (typeof value !== 'string') validation('Invalid Booking Quote fingerprint');
  const match = fingerprintPattern.exec(value);
  if (!match || match[0] !== value) validation('Invalid Booking Quote fingerprint');
  return { keyId: match[1]!, mac: match[2]! };
}

export function createBookingAvailabilityQuoteReservation(
  properties: BookingPropertyLockedQuoteFactsLookup,
  limits: BookingQuoteLimits,
  keyring: Keyring,
  repository: QuoteReservationRepository = new BookingAvailabilityRepository(),
): BookingAvailabilityQuoteReservation {
  const parsedLimits = bookingQuoteLimitsSchema.safeParse(limits);
  if (!parsedLimits.success) throw new TypeError(`Invalid Booking Quote reservation limits: ${parsedLimits.error.message}`);
  assertQuoteSigningKeyring(keyring);
  const { maxRoomsPerRequest } = parsedLimits.data;

  return Object.freeze({
    async revalidateAndReserve(
      tx: Tx,
      rawRequest: BookingQuoteInput,
      expectedFingerprint: string,
      now: Date,
    ): Promise<BookingQuoteReservationResult> {
      const parsedRequest = bookingQuoteInputSchema.safeParse(rawRequest);
      if (!parsedRequest.success) validation('Invalid Booking Quote input', parsedRequest.error.issues);
      const fingerprint = parseFingerprint(expectedFingerprint);
      const parsedNow = reservationClockSchema.safeParse(now);
      if (!parsedNow.success) validation('Booking Quote reservation clock must be a valid date', parsedNow.error.issues);

      const input = parsedRequest.data;
      const nightCount = staticStayValidation(input, maxRoomsPerRequest);

      const ownerFacts = await properties.requireLockedQuoteFacts(tx, input.roomTypeId);
      validatePropertyHorizon(input, ownerFacts.property, parsedNow.data);
      const eligibilityError = roomTypeEligibilityError(input, nightCount, ownerFacts.roomType);
      if (eligibilityError) validation(eligibilityError);

      const basePrice = await repository.lockBasePrice(tx, input.roomTypeId);
      if (!basePrice) throw PlatformError.conflict('Base nightly price is not configured for this Room Type');

      const dates = localDateRange(input.checkInLocalDate, input.checkOutLocalDate);
      await repository.materializeRoomNightsInDateOrder(tx, input.roomTypeId, dates, parsedNow.data);
      const lockedNights = await repository.lockRoomNights(tx, input.roomTypeId, dates);
      if (lockedNights.length !== dates.length || lockedNights.some((night, index) => night.localDate !== dates[index])) {
        throw PlatformError.conflict('The Room Night range changed while the Quote was being reserved');
      }

      const snapshot = lockedNights.map(night => ({
        baseNightlyPriceMinor: basePrice.baseNightlyPriceMinor,
        localDate: night.localDate,
        sellableUnits: night.sellableUnits,
        reservedUnits: night.reservedUnits,
        nightlyPriceOverrideMinor: night.nightlyPriceOverrideMinor,
      }));
      const cancellationPolicy = {
        freeCancellationHoursBeforeCheckIn: ownerFacts.property.defaultPolicy.freeCancellationHoursBeforeCheckIn,
        propertyTimeZone: ownerFacts.property.timezone,
        checkInTime: ownerFacts.property.checkInTime,
      };
      const current = makeQuote(
        input, ownerFacts.property.id, ownerFacts.property.currency, cancellationPolicy, snapshot, nightCount, keyring,
      );
      if (current.kind === 'unavailable') return { kind: 'unavailable' };

      const quote = current.quote;
      const fingerprintNights = quote.nights.map((night, index) => ({
        localDate: night.localDate,
        nightlyPriceMinor: night.nightlyPriceMinor,
        availableUnits: lockedNights[index]!.sellableUnits - lockedNights[index]!.reservedUnits,
      }));
      const terms = bookingQuoteFingerprintTerms(
        input, ownerFacts.property.id, ownerFacts.property.currency, fingerprintNights, quote.totalMinor, cancellationPolicy,
      );
      const matches = keyring.has(fingerprint.keyId)
        && constantTimeEquals(bookingQuoteFingerprintForKey(terms, keyring, fingerprint.keyId), fingerprint.mac);
      if (!matches) return { kind: 'stale', replacementQuote: quote };

      const updated = await repository.adjustReservedUnits(tx, input.roomTypeId, dates, input.roomCount, parsedNow.data);
      if (updated !== dates.length) {
        throw PlatformError.conflict('The Room Night range changed while the Quote was being reserved');
      }
      return { kind: 'reserved', quote };
    },
  });
}
