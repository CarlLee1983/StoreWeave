import { canonicalJson } from '@storeweave/command-bus';
import { PlatformError, defineQuery, type DrizzleDb, type Tx, type QueryContext } from '@storeweave/contracts';
import { hmacSha256, type Keyring } from '@storeweave/crypto';
import { z } from 'zod';
import { BookingAvailabilityRepository } from './repository';
import { isCanonicalLocalDate, localDateRange, MAX_BOOKING_STAY_NIGHTS, type BookingPropertyLookup } from './types';

export const MAX_BOOKING_HORIZON_DAYS = 365;
const BOOKING_QUOTE_FINGERPRINT_PURPOSE = 'booking-quote';

export const bookingQuoteLimitsSchema = z.object({
  maxRoomsPerRequest: z.number().int().safe().min(1),
}).strict();

export type BookingQuoteLimits = z.infer<typeof bookingQuoteLimitsSchema>;

export const bookingStayInputSchema = z.object({
  checkInLocalDate: z.string().refine(isCanonicalLocalDate, 'Expected a canonical calendar date in YYYY-MM-DD form'),
  checkOutLocalDate: z.string().refine(isCanonicalLocalDate, 'Expected a canonical calendar date in YYYY-MM-DD form'),
  adults: z.number().int().safe().min(0),
  children: z.number().int().safe().min(0),
  roomCount: z.number().int().safe().min(1),
}).strict();
export const bookingQuoteInputSchema = bookingStayInputSchema.extend({ roomTypeId: z.string().uuid() }).strict();

const bookingQuoteNightSchema = z.object({
  localDate: z.string(),
  nightlyPriceMinor: z.number().int().safe().nonnegative(),
  nightlyTotalMinor: z.number().int().safe().nonnegative(),
}).strict();

const cancellationPolicySnapshotSchema = z.object({
  freeCancellationHoursBeforeCheckIn: z.number().int().min(0).max(8760),
  propertyTimeZone: z.string().min(1),
  checkInTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
}).strict();

export const bookingQuoteSchema = z.object({
  roomTypeId: z.string().uuid(),
  checkInLocalDate: z.string(),
  checkOutLocalDate: z.string(),
  adults: z.number().int().safe().min(0),
  children: z.number().int().safe().min(0),
  roomCount: z.number().int().safe().min(1),
  currency: z.string().length(3),
  nights: z.array(bookingQuoteNightSchema).min(1).max(MAX_BOOKING_STAY_NIGHTS),
  totalMinor: z.number().int().safe().nonnegative(),
  cancellationPolicy: cancellationPolicySnapshotSchema,
  fingerprint: z.string().regex(/^booking-quote-v1:[a-z][a-z0-9-]{0,63}:[0-9a-f]{64}$/),
}).strict();

export const bookingQuoteResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('available'), quote: bookingQuoteSchema }).strict(),
  z.object({ kind: z.literal('unavailable') }).strict(),
]);

export type BookingQuoteInput = z.infer<typeof bookingQuoteInputSchema>;
export type BookingStayRequest = z.infer<typeof bookingStayInputSchema>;
export type BookingQuote = z.infer<typeof bookingQuoteSchema>;
export type BookingQuoteResult = z.infer<typeof bookingQuoteResultSchema>;

export interface BookingAvailabilityQuoteCapability {
  quote(db: DrizzleDb | Tx, input: BookingQuoteInput, now: Date): Promise<BookingQuoteResult>;
}

export type QuoteSnapshotRow = Awaited<ReturnType<BookingAvailabilityRepository['loadQuoteSnapshot']>>[number];
export type QuoteSnapshotRepository = Pick<BookingAvailabilityRepository, 'loadQuoteSnapshot'>;

function civilDateOrdinal(value: string): number {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 86_400_000);
}

function propertyLocalDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${String(fields.year).padStart(4, '0')}-${fields.month}-${fields.day}`;
}

function invalid(message: string): never {
  throw PlatformError.validation(message);
}

type BookingQuoteFingerprintTerms = {
  readonly domain: 'booking-quote-v1';
  readonly propertyId: string;
  readonly request: BookingQuoteInput;
  readonly currency: string;
  readonly nights: readonly { readonly localDate: string; readonly nightlyPriceMinor: number; readonly availableUnits: number }[];
  readonly totalMinor: number;
  readonly cancellationPolicy: BookingQuote['cancellationPolicy'];
};

export function bookingQuoteFingerprintTerms(
  input: BookingQuoteInput,
  propertyId: string,
  currency: string,
  nights: BookingQuoteFingerprintTerms['nights'],
  totalMinor: number,
  cancellationPolicy: BookingQuote['cancellationPolicy'],
): BookingQuoteFingerprintTerms {
  return { domain: 'booking-quote-v1', propertyId, request: input, currency, nights, totalMinor, cancellationPolicy };
}

export function bookingQuoteFingerprintForKey(
  terms: BookingQuoteFingerprintTerms,
  keyring: Keyring,
  keyId: string,
): string {
  const key = keyring.derive(BOOKING_QUOTE_FINGERPRINT_PURPOSE, keyId);
  try {
    const digest = hmacSha256(key, canonicalJson(terms));
    try {
      return digest.toString('hex');
    } finally {
      digest.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

export function assertQuoteSigningKeyring(keyring: Keyring): void {
  if (!keyring || typeof keyring.activeKeyId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(keyring.activeKeyId)
    || typeof keyring.derive !== 'function') {
    throw new TypeError('Booking Availability Quote requires a configured signing Keyring');
  }
  const probe = keyring.derive(BOOKING_QUOTE_FINGERPRINT_PURPOSE, keyring.activeKeyId);
  try {
    if (!Buffer.isBuffer(probe) || probe.length < 32) {
      throw new TypeError('Booking Availability Quote signing Keyring must derive at least 32 bytes');
    }
  } finally {
    if (Buffer.isBuffer(probe)) probe.fill(0);
  }
}

export function staticStayValidation(input: BookingStayRequest, maxRoomsPerRequest: number): number {
  const nights = civilDateOrdinal(input.checkOutLocalDate) - civilDateOrdinal(input.checkInLocalDate);
  if (nights <= 0) invalid('Check-out date must be after check-in date');
  if (nights > MAX_BOOKING_STAY_NIGHTS) invalid(`A stay may not exceed ${MAX_BOOKING_STAY_NIGHTS} nights`);
  if (input.roomCount > maxRoomsPerRequest) invalid(`Room count exceeds the configured limit of ${maxRoomsPerRequest}`);
  if (input.adults < input.roomCount) invalid('Each requested room requires at least one adult');
  return nights;
}

type PropertyFacts = NonNullable<Awaited<ReturnType<BookingPropertyLookup['getProperty']>>>;
type RoomTypeFacts = NonNullable<Awaited<ReturnType<BookingPropertyLookup['getActiveRoomType']>>>;

export function validatePropertyHorizon(input: BookingStayRequest, property: PropertyFacts, now: Date): void {
  const today = propertyLocalDate(now, property.timezone);
  const checkInOffset = civilDateOrdinal(input.checkInLocalDate) - civilDateOrdinal(today);
  if (checkInOffset < 0 || checkInOffset > MAX_BOOKING_HORIZON_DAYS) {
    invalid(`Check-in must be between Property-local today and ${MAX_BOOKING_HORIZON_DAYS} days ahead`);
  }
}

/** A Room-Type-only mismatch excludes one search choice; it remains a validation error for a direct Quote. */
export function roomTypeEligibilityError(input: BookingStayRequest, nights: number, roomType: RoomTypeFacts): string | null {
  if (nights < roomType.minimumStayNights) return `Stay must be at least ${roomType.minimumStayNights} nights for this Room Type`;
  if (roomType.maximumStayNights !== null && nights > roomType.maximumStayNights) {
    return `Stay may not exceed ${roomType.maximumStayNights} nights for this Room Type`;
  }
  if (BigInt(input.adults) + BigInt(input.children) > BigInt(input.roomCount) * BigInt(roomType.maxOccupancyPerUnit)) {
    return 'Guest count exceeds the selected Room Type occupancy';
  }
  return null;
}

function validateOwnerFacts(
  input: BookingQuoteInput,
  nights: number,
  property: PropertyFacts,
  roomType: RoomTypeFacts,
  now: Date,
): void {
  validatePropertyHorizon(input, property, now);
  const error = roomTypeEligibilityError(input, nights, roomType);
  if (error) invalid(error);
}

export function makeQuote(
  input: BookingQuoteInput,
  propertyId: string,
  currency: string,
  cancellationPolicy: BookingQuote['cancellationPolicy'],
  snapshot: readonly QuoteSnapshotRow[],
  expectedNightCount: number,
  keyring: Keyring,
): BookingQuoteResult {
  const baseNightlyPriceMinor = snapshot[0]?.baseNightlyPriceMinor;
  if (baseNightlyPriceMinor === undefined || snapshot.length === 0) {
    throw PlatformError.conflict('Base nightly price is not configured for this Room Type');
  }

  const byDate = new Map(snapshot
    .filter((row): row is QuoteSnapshotRow & { localDate: string } => row.localDate !== null)
    .map(row => [row.localDate, row]));
  const nights: BookingQuote['nights'] = [];
  const fingerprintNights: { localDate: string; nightlyPriceMinor: number; availableUnits: number }[] = [];
  let totalMinor = 0n;

  for (const localDate of localDateRange(input.checkInLocalDate, input.checkOutLocalDate)) {
    const row = byDate.get(localDate);
    if (!row || row.sellableUnits === null || row.reservedUnits === null) return { kind: 'unavailable' };
    const availableUnits = row.sellableUnits - row.reservedUnits;
    if (availableUnits < input.roomCount) return { kind: 'unavailable' };
    const nightlyPriceMinor = row.nightlyPriceOverrideMinor ?? baseNightlyPriceMinor;
    if (nightlyPriceMinor === null) return { kind: 'unavailable' };
    const nightlyTotalMinor = BigInt(nightlyPriceMinor) * BigInt(input.roomCount);
    if (nightlyTotalMinor > BigInt(Number.MAX_SAFE_INTEGER)) invalid('Quote total exceeds the supported currency range');
    nights.push({ localDate, nightlyPriceMinor, nightlyTotalMinor: Number(nightlyTotalMinor) });
    fingerprintNights.push({ localDate, nightlyPriceMinor, availableUnits });
    totalMinor += nightlyTotalMinor;
  }

  if (nights.length !== expectedNightCount) return { kind: 'unavailable' };
  if (totalMinor > BigInt(Number.MAX_SAFE_INTEGER)) invalid('Quote total exceeds the supported currency range');
  const keyId = keyring.activeKeyId;
  const quoteTerms = bookingQuoteFingerprintTerms(input, propertyId, currency, fingerprintNights, Number(totalMinor), cancellationPolicy);
  const mac = bookingQuoteFingerprintForKey(quoteTerms, keyring, keyId);
  const fingerprint = `booking-quote-v1:${keyId}:${mac}`;
  return {
    kind: 'available',
    quote: {
      ...input,
      currency,
      nights,
      totalMinor: Number(totalMinor),
      cancellationPolicy,
      fingerprint,
    },
  };
}

const defaultRepository = new BookingAvailabilityRepository();

export function createBookingAvailabilityQuote(
  properties: BookingPropertyLookup,
  limits: BookingQuoteLimits,
  keyring: Keyring,
  repository: QuoteSnapshotRepository = defaultRepository,
): BookingAvailabilityQuoteCapability {
  const parsedLimits = bookingQuoteLimitsSchema.safeParse(limits);
  if (!parsedLimits.success) throw new TypeError(`Invalid Booking Availability Quote limits: ${parsedLimits.error.message}`);
  assertQuoteSigningKeyring(keyring);
  const { maxRoomsPerRequest } = parsedLimits.data;

  return Object.freeze({
    async quote(db: DrizzleDb | Tx, rawInput: BookingQuoteInput, now: Date): Promise<BookingQuoteResult> {
      const parsedInput = bookingQuoteInputSchema.safeParse(rawInput);
      if (!parsedInput.success) throw PlatformError.validation('Invalid Booking Quote input', parsedInput.error.issues);
      if (!Number.isFinite(now.getTime())) invalid('Quote clock must be a valid date');

      const input = parsedInput.data;
      const nightCount = staticStayValidation(input, maxRoomsPerRequest);

      const property = await properties.getProperty(db);
      if (!property) throw PlatformError.conflict('Booking Property is not configured');
      const roomType = await properties.getActiveRoomType(db, input.roomTypeId);
      if (!roomType) throw PlatformError.notFound('Active Room Type', input.roomTypeId);
      validateOwnerFacts(input, nightCount, property, roomType, now);

      const snapshot = await repository.loadQuoteSnapshot(db, input.roomTypeId, input.checkInLocalDate, input.checkOutLocalDate);
      const cancellationPolicy = {
        freeCancellationHoursBeforeCheckIn: property.defaultPolicy.freeCancellationHoursBeforeCheckIn,
        propertyTimeZone: property.timezone,
        checkInTime: property.checkInTime,
      };
      return makeQuote(input, property.id, property.currency, cancellationPolicy, snapshot, nightCount, keyring);
    },
  });
}

export const getBookingQuoteQuery = defineQuery({
  name: 'booking.availability.getQuote',
  summary: '依目前供應、價格與取消政策取得非持久 Booking Quote',
  input: bookingQuoteInputSchema,
  output: bookingQuoteResultSchema,
  permission: 'booking-availability:quote',
});

export function createGetBookingQuoteHandler(quote: BookingAvailabilityQuoteCapability) {
  return (input: BookingQuoteInput, context: QueryContext) => quote.quote(context.db, input, context.now);
}
