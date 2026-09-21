import { z } from 'zod';
import type { DrizzleDb, Tx } from '@storeweave/contracts';

export const MAX_ROOM_NIGHTS_PER_UPDATE = 366;
export const MAX_MONEY_MINOR = 2_147_483_647;
export const MAX_ROOM_UNITS = 2_147_483_647;
export const MAX_BOOKING_STAY_NIGHTS = 30;

export function isCanonicalLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function epochForLocalDate(value: string): number {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

export function localDateRange(startLocalDate: string, endLocalDateExclusive: string): string[] {
  const start = epochForLocalDate(startLocalDate);
  const end = epochForLocalDate(endLocalDateExclusive);
  const dates: string[] = [];
  for (let current = start; current < end; current += 86_400_000) {
    const date = new Date(current);
    dates.push(`${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`);
  }
  return dates;
}

const localDateSchema = z.string().refine(isCanonicalLocalDate, 'Expected a canonical calendar date in YYYY-MM-DD form');
const roomTypeIdSchema = z.string().uuid();
const moneyMinorSchema = z.number().int().min(0).max(MAX_MONEY_MINOR);
const unitsSchema = z.number().int().min(0).max(MAX_ROOM_UNITS);

function dateRangeIssues(
  value: { startLocalDate: string; endLocalDateExclusive: string },
  context: z.RefinementCtx,
): void {
  if (value.startLocalDate >= value.endLocalDateExclusive) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['endLocalDateExclusive'], message: 'End date must be after the start date' });
    return;
  }
  const count = (epochForLocalDate(value.endLocalDateExclusive) - epochForLocalDate(value.startLocalDate)) / 86_400_000;
  if (count > MAX_ROOM_NIGHTS_PER_UPDATE) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['endLocalDateExclusive'], message: `A range may contain at most ${MAX_ROOM_NIGHTS_PER_UPDATE} local dates` });
  }
}

export const setBaseNightlyPriceInputSchema = z.object({
  roomTypeId: roomTypeIdSchema,
  baseNightlyPriceMinor: moneyMinorSchema,
}).strict();

export const setBaseNightlyPriceOutputSchema = z.object({
  roomTypeId: roomTypeIdSchema,
  baseNightlyPriceMinor: moneyMinorSchema,
}).strict();

export const updateRoomNightRangeInputSchema = z.object({
  roomTypeId: roomTypeIdSchema,
  startLocalDate: localDateSchema,
  endLocalDateExclusive: localDateSchema,
  sellableUnits: unitsSchema.optional(),
  nightlyPriceOverrideMinor: moneyMinorSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  dateRangeIssues(value, context);
  if (value.sellableUnits === undefined && value.nightlyPriceOverrideMinor === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sellableUnits'], message: 'Set sellable units or a nightly price override' });
  }
});

export const updateRoomNightRangeOutputSchema = z.object({ updated: z.number().int().nonnegative() }).strict();

export const roomNightViewSchema = z.object({
  localDate: localDateSchema,
  sellableUnits: unitsSchema,
  reservedUnits: unitsSchema,
  nightlyPriceOverrideMinor: moneyMinorSchema.nullable(),
  effectiveNightlyPriceMinor: moneyMinorSchema.nullable(),
}).strict();

export const getRoomNightRangeInputSchema = z.object({
  roomTypeId: roomTypeIdSchema,
  startLocalDate: localDateSchema,
  endLocalDateExclusive: localDateSchema,
}).strict().superRefine(dateRangeIssues);

export const roomNightRangeViewSchema = z.object({
  roomTypeId: roomTypeIdSchema,
  propertyTimeZone: z.string().min(1),
  currency: z.string().length(3),
  baseNightlyPriceMinor: moneyMinorSchema.nullable(),
  nights: z.array(roomNightViewSchema),
}).strict();

export type BookingPropertyLookup = {
  getProperty(db: DrizzleDb | Tx): Promise<{
    id: string;
    timezone: string;
    currency: string;
    checkInTime: string;
    defaultPolicy: { freeCancellationHoursBeforeCheckIn: number };
  } | null>;
  getActiveRoomType(db: DrizzleDb | Tx, roomTypeId: string): Promise<{
    id: string;
    maxOccupancyPerUnit: number;
    minimumStayNights: number;
    maximumStayNights: number | null;
  } | null>;
  listActiveRoomTypes(db: DrizzleDb | Tx): Promise<readonly {
    id: string;
    name: string;
    maxOccupancyPerUnit: number;
    minimumStayNights: number;
    maximumStayNights: number | null;
  }[]>;
};

export type BookingPropertyLockedQuoteFactsLookup = {
  requireLockedQuoteFacts(tx: Tx, roomTypeId: string): Promise<{
    property: {
      id: string;
      timezone: string;
      currency: string;
      checkInTime: string;
      defaultPolicy: { freeCancellationHoursBeforeCheckIn: number };
    };
    roomType: {
      id: string;
      maxOccupancyPerUnit: number;
      minimumStayNights: number;
      maximumStayNights: number | null;
    };
  }>;
};

export type SetBaseNightlyPriceInput = z.infer<typeof setBaseNightlyPriceInputSchema>;
export type UpdateRoomNightRangeInput = z.infer<typeof updateRoomNightRangeInputSchema>;
