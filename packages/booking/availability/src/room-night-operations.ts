import { PlatformError, type Tx } from '@storeweave/contracts';
import { z } from 'zod';
import { BookingAvailabilityRepository } from './repository';
import type { BookingAvailabilityRoomNightRow } from './schema';
import {
  isCanonicalLocalDate, localDateRange, MAX_BOOKING_STAY_NIGHTS, MAX_ROOM_UNITS,
} from './types';

export const BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY = 'booking.availability.room-night-operations.v1';

function localDateOrdinal(value: string): number {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 86_400_000);
}

export const roomNightOperationInputSchema = z.object({
  roomTypeId: z.string().uuid(),
  startLocalDate: z.string().refine(isCanonicalLocalDate, 'Expected a canonical calendar date in YYYY-MM-DD form'),
  endLocalDateExclusive: z.string().refine(isCanonicalLocalDate, 'Expected a canonical calendar date in YYYY-MM-DD form'),
  roomCount: z.number().int().safe().min(1).max(MAX_ROOM_UNITS),
}).strict().superRefine((input, context) => {
  if (!isCanonicalLocalDate(input.startLocalDate) || !isCanonicalLocalDate(input.endLocalDateExclusive)) return;
  const nightCount = localDateOrdinal(input.endLocalDateExclusive) - localDateOrdinal(input.startLocalDate);
  if (nightCount <= 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['endLocalDateExclusive'], message: 'End date must be after the start date' });
  } else if (nightCount > MAX_BOOKING_STAY_NIGHTS) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['endLocalDateExclusive'], message: `A reservation may not exceed ${MAX_BOOKING_STAY_NIGHTS} nights` });
  }
});

export type RoomNightOperationInput = z.infer<typeof roomNightOperationInputSchema>;
export type RoomNightOperationResult = { readonly kind: 'reserved' | 'unavailable' };
export type RoomNightReleaseResult = { readonly kind: 'released' };

export interface BookingAvailabilityRoomNightOperations {
  reserve(tx: Tx, rawInput: RoomNightOperationInput, now: Date): Promise<RoomNightOperationResult>;
  release(tx: Tx, rawInput: RoomNightOperationInput, now: Date): Promise<RoomNightReleaseResult>;
}

type RoomNightOperationsRepository = Pick<BookingAvailabilityRepository,
  'getBasePrice' | 'materializeRoomNightsInDateOrder' | 'lockRoomNights' | 'adjustReservedUnits'>;

function parseOperationInput(rawInput: RoomNightOperationInput, now: Date): { input: RoomNightOperationInput; dates: string[] } {
  const parsed = roomNightOperationInputSchema.safeParse(rawInput);
  if (!parsed.success) throw PlatformError.validation('Invalid Room Night operation input', parsed.error.issues);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw PlatformError.validation('Room Night operation clock must be a valid date');
  }
  const input = parsed.data;
  return { input, dates: localDateRange(input.startLocalDate, input.endLocalDateExclusive) };
}

function exactRange(rows: readonly BookingAvailabilityRoomNightRow[], dates: readonly string[]): boolean {
  return rows.length === dates.length && rows.every((row, index) => row.localDate === dates[index]);
}

export function createBookingAvailabilityRoomNightOperations(
  repository: RoomNightOperationsRepository = new BookingAvailabilityRepository(),
): BookingAvailabilityRoomNightOperations {
  return Object.freeze({
    async reserve(tx: Tx, rawInput: RoomNightOperationInput, now: Date): Promise<RoomNightOperationResult> {
      const { input, dates } = parseOperationInput(rawInput, now);
      if (!await repository.getBasePrice(tx, input.roomTypeId)) return { kind: 'unavailable' };

      await repository.materializeRoomNightsInDateOrder(tx, input.roomTypeId, dates, now);
      const current = await repository.lockRoomNights(tx, input.roomTypeId, dates);
      if (!exactRange(current, dates)) {
        throw PlatformError.conflict('The Room Night range changed while it was being reserved');
      }
      if (current.some(night => night.sellableUnits - night.reservedUnits < input.roomCount)) {
        return { kind: 'unavailable' };
      }

      const updated = await repository.adjustReservedUnits(tx, input.roomTypeId, dates, input.roomCount, now);
      if (updated !== dates.length) throw PlatformError.conflict('The Room Night range changed while it was being reserved');
      return { kind: 'reserved' };
    },

    async release(tx: Tx, rawInput: RoomNightOperationInput, now: Date): Promise<RoomNightReleaseResult> {
      const { input, dates } = parseOperationInput(rawInput, now);
      const current = await repository.lockRoomNights(tx, input.roomTypeId, dates);
      if (!exactRange(current, dates) || current.some(night => night.reservedUnits < input.roomCount)) {
        throw PlatformError.conflict('The Room Night range cannot release the requested reserved units');
      }

      const updated = await repository.adjustReservedUnits(tx, input.roomTypeId, dates, -input.roomCount, now);
      if (updated !== dates.length) throw PlatformError.conflict('The Room Night range changed while it was being released');
      return { kind: 'released' };
    },
  });
}

/** Availability owns only supply. Quote and Property facts are validated by the caller. */
export const bookingAvailabilityRoomNightOperations = createBookingAvailabilityRoomNightOperations();
