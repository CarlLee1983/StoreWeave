import { PlatformError } from '@storeweave/contracts';
import { definePage, type PageOutcome, type PageResolveContext, type StorefrontHttpContract } from '@storeweave/kernel';
import { z } from 'zod';
import { bookingQuoteInputSchema, type BookingQuote, type BookingQuoteInput } from './quote';
import { bookingSearchInputSchema, type BookingSearchChoice, type BookingSearchInput, type BookingSearchResult } from './search';

const queryValue = z.unknown().optional();
const searchPageInputSchema = z.object({
  checkInLocalDate: queryValue,
  checkOutLocalDate: queryValue,
  adults: queryValue,
  children: queryValue,
  roomCount: queryValue,
}).passthrough();
const quotePageInputSchema = z.object({
  roomTypeId: queryValue,
  checkInLocalDate: queryValue,
  checkOutLocalDate: queryValue,
  adults: queryValue,
  children: queryValue,
  roomCount: queryValue,
  expectedFingerprint: queryValue,
}).passthrough();

const responses: StorefrontHttpContract['responses'] = [
  { kind: 'html', status: 200, contentType: 'text/html; charset=utf-8', body: 'theme' },
  { kind: 'html', status: 400, contentType: 'text/html; charset=utf-8', body: 'theme' },
  { kind: 'html', status: 'platform-error', contentType: 'text/html; charset=utf-8', body: 'theme' },
];

const searchRequestContract = {
  type: 'object',
  properties: {
    checkInLocalDate: { type: 'string' },
    checkOutLocalDate: { type: 'string' },
    adults: { type: 'string' },
    children: { type: 'string' },
    roomCount: { type: 'string' },
  },
  additionalProperties: false,
} as const;

const quoteRequestContract = {
  type: 'object',
  required: ['roomTypeId', 'checkInLocalDate', 'checkOutLocalDate', 'adults', 'children', 'roomCount'],
  properties: {
    roomTypeId: { type: 'string', format: 'uuid' },
    checkInLocalDate: { type: 'string' },
    checkOutLocalDate: { type: 'string' },
    adults: { type: 'string' },
    children: { type: 'string' },
    roomCount: { type: 'string' },
    expectedFingerprint: { type: 'string' },
  },
  additionalProperties: false,
} as const;

export type BookingSearchFormValues = Readonly<Record<'checkInLocalDate' | 'checkOutLocalDate' | 'adults' | 'children' | 'roomCount', string>>;

export type BookingSearchPageView =
  | { readonly kind: 'form'; readonly values: BookingSearchFormValues; readonly message?: string }
  | { readonly kind: 'results'; readonly choices: readonly BookingSearchChoice[] }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'validation-error'; readonly values: BookingSearchFormValues; readonly message: string };

export type BookingQuotePageView =
  | { readonly kind: 'current'; readonly quote: BookingQuote }
  | { readonly kind: 'refreshed'; readonly quote: BookingQuote; readonly expectedFingerprint: string }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'validation-error'; readonly values: Readonly<Record<string, string>>; readonly message: string };

function queryCount(value: unknown): unknown {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

function displayValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function searchValues(input: z.infer<typeof searchPageInputSchema>): BookingSearchFormValues {
  return {
    checkInLocalDate: displayValue(input.checkInLocalDate),
    checkOutLocalDate: displayValue(input.checkOutLocalDate),
    adults: displayValue(input.adults),
    children: displayValue(input.children),
    roomCount: displayValue(input.roomCount),
  };
}

function quoteValues(input: z.infer<typeof quotePageInputSchema>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, displayValue(value)]));
}

function withUnexpectedQuery<T extends Record<string, unknown>>(
  input: Record<string, unknown>, allowed: readonly string[], request: T,
): T & Record<string, unknown> {
  const target = request as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!allowed.includes(key)) target[key] = input[key];
  return request;
}

function isValidationFailure(error: unknown): error is PlatformError {
  return error instanceof PlatformError && error.code === 'VALIDATION_ERROR';
}

function validationMessage(error: PlatformError | z.ZodIssue[]): string {
  return error instanceof PlatformError ? error.message : error[0]?.message ?? 'Invalid input';
}

const searchKeys = ['checkInLocalDate', 'checkOutLocalDate', 'adults', 'children', 'roomCount'] as const;
const quoteKeys = ['roomTypeId', 'checkInLocalDate', 'checkOutLocalDate', 'adults', 'children', 'roomCount'] as const;
const expectedFingerprintPattern = /^booking-quote-v1:[a-z][a-z0-9-]{0,63}:[0-9a-f]{64}$/;

async function searchQuotes(ctx: PageResolveContext, input: BookingSearchInput): Promise<BookingSearchResult> {
  return ctx.queries.execute<BookingSearchResult>(
    'booking.availability.searchQuotes', input, { actor: ctx.actor },
  );
}

async function currentQuote(ctx: PageResolveContext, input: BookingQuoteInput) {
  return ctx.queries.execute<{ kind: 'available'; quote: BookingQuote } | { kind: 'unavailable' }>(
    'booking.availability.getQuote', input, { actor: ctx.actor },
  );
}

export const bookingAvailabilityPages = {
  search: definePage({
    id: 'booking.availability.search',
    path: '/booking/search',
    method: 'get',
    audience: 'public',
    input: searchPageInputSchema,
    contract: { kind: 'storefront', request: 'query', input: searchRequestContract, responses },
    resolve: async (ctx, raw): Promise<PageOutcome<BookingSearchPageView>> => {
      const values = searchValues(raw);
      if (Object.keys(raw).length === 0) return { kind: 'view', view: { kind: 'form', values } };
      const request = withUnexpectedQuery(raw, searchKeys, {
        checkInLocalDate: raw.checkInLocalDate,
        checkOutLocalDate: raw.checkOutLocalDate,
        adults: queryCount(raw.adults),
        children: queryCount(raw.children),
        roomCount: queryCount(raw.roomCount),
      }) as BookingSearchInput;
      const parsed = bookingSearchInputSchema.safeParse(request);
      if (!parsed.success) {
        return { kind: 'view', view: { kind: 'validation-error', values, message: validationMessage(parsed.error.issues) }, status: 400 };
      }
      try {
        const result = await searchQuotes(ctx, parsed.data);
        return result.kind === 'available'
          ? { kind: 'view', view: { kind: 'results', choices: result.choices } }
          : { kind: 'view', view: { kind: 'unavailable' } };
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw PlatformError.internal('Booking Search query returned invalid data', error.issues);
        }
        if (!isValidationFailure(error)) throw error;
        return { kind: 'view', view: { kind: 'validation-error', values, message: error.message }, status: 400 };
      }
    },
  }),

  quote: definePage({
    id: 'booking.availability.quote',
    path: '/booking/quote',
    method: 'get',
    audience: 'public',
    input: quotePageInputSchema,
    contract: { kind: 'storefront', request: 'query', input: quoteRequestContract, responses },
    resolve: async (ctx, raw): Promise<PageOutcome<BookingQuotePageView>> => {
      const values = quoteValues(raw);
      const expectedFingerprint = typeof raw.expectedFingerprint === 'string' ? raw.expectedFingerprint : undefined;
      if (raw.expectedFingerprint !== undefined
        && (typeof raw.expectedFingerprint !== 'string' || !expectedFingerprintPattern.test(raw.expectedFingerprint))) {
        return { kind: 'view', view: { kind: 'validation-error', values, message: 'Invalid expected Quote fingerprint' }, status: 400 };
      }
      const request = withUnexpectedQuery(raw, [...quoteKeys, 'expectedFingerprint'], {
        roomTypeId: raw.roomTypeId,
        checkInLocalDate: raw.checkInLocalDate,
        checkOutLocalDate: raw.checkOutLocalDate,
        adults: queryCount(raw.adults),
        children: queryCount(raw.children),
        roomCount: queryCount(raw.roomCount),
      }) as BookingQuoteInput;
      const parsed = bookingQuoteInputSchema.safeParse(request);
      if (!parsed.success) {
        return { kind: 'view', view: { kind: 'validation-error', values, message: validationMessage(parsed.error.issues) }, status: 400 };
      }
      try {
        const result = await currentQuote(ctx, parsed.data);
        if (result.kind === 'unavailable') return { kind: 'view', view: { kind: 'unavailable' } };
        if (expectedFingerprint && expectedFingerprint !== result.quote.fingerprint) {
          return { kind: 'view', view: { kind: 'refreshed', quote: result.quote, expectedFingerprint } };
        }
        return { kind: 'view', view: { kind: 'current', quote: result.quote } };
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw PlatformError.internal('Booking Quote query returned invalid data', error.issues);
        }
        if (!isValidationFailure(error)) throw error;
        return { kind: 'view', view: { kind: 'validation-error', values, message: error.message }, status: 400 };
      }
    },
  }),
} as const;

export type BookingAvailabilityPages = typeof bookingAvailabilityPages;
