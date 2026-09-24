import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import { BookingAvailabilityRepository } from './repository';
import {
  setBaseNightlyPriceInputSchema, setBaseNightlyPriceOutputSchema,
  updateRoomNightRangeInputSchema, updateRoomNightRangeOutputSchema, localDateRange,
  type BookingPropertyLookup,
} from './types';

const repository = new BookingAvailabilityRepository();

export const setBaseNightlyPriceCommand = defineCommand({
  name: 'booking.availability.setBaseNightlyPrice',
  summary: '設定 Room Type 的 Availability 基本每晚價格',
  input: setBaseNightlyPriceInputSchema,
  output: setBaseNightlyPriceOutputSchema,
  permission: 'booking-availability:manage',
  idempotency: 'required',
  audit: {
    action: 'booking.availability.base-nightly-price-set', resourceType: 'booking_room_type',
    resourceId: (input: { roomTypeId: string }) => input.roomTypeId,
  },
});

export const updateRoomNightRangeCommand = defineCommand({
  name: 'booking.availability.updateRoomNightRange',
  summary: '更新 Property 當地日期的 Room Night 供應與價格覆寫',
  input: updateRoomNightRangeInputSchema,
  output: updateRoomNightRangeOutputSchema,
  permission: 'booking-availability:manage',
  idempotency: 'required',
  audit: {
    action: 'booking.availability.room-night-range-updated', resourceType: 'booking_room_type',
    resourceId: (input: { roomTypeId: string }) => input.roomTypeId,
  },
});

export function createSetBaseNightlyPriceHandler(properties: BookingPropertyLookup) {
  return async (input: { roomTypeId: string; baseNightlyPriceMinor: number }, context: CommandContext) => {
    const property = await properties.getProperty(context.tx);
    const roomType = await properties.getActiveRoomType(context.tx, input.roomTypeId);
    if (!roomType) throw PlatformError.notFound('Active Booking Room Type', input.roomTypeId);
    if (!property) throw PlatformError.conflict('Create the Booking Property before Availability prices');
    await repository.setBasePrice(context.tx, input.roomTypeId, input.baseNightlyPriceMinor, context.now);
    return { roomTypeId: input.roomTypeId, baseNightlyPriceMinor: input.baseNightlyPriceMinor };
  };
}

export function createUpdateRoomNightRangeHandler(properties: BookingPropertyLookup) {
  return async (input: {
    roomTypeId: string;
    startLocalDate: string;
    endLocalDateExclusive: string;
    sellableUnits?: number;
    nightlyPriceOverrideMinor?: number | null;
  }, context: CommandContext) => {
    const dates = localDateRange(input.startLocalDate, input.endLocalDateExclusive);
    const property = await properties.getProperty(context.tx);
    const roomType = await properties.getActiveRoomType(context.tx, input.roomTypeId);
    const basePrice = await repository.getBasePrice(context.tx, input.roomTypeId);
    if (!roomType) throw PlatformError.notFound('Active Booking Room Type', input.roomTypeId);
    if (!property) throw PlatformError.conflict('Create the Booking Property before Room Night administration');
    if (!basePrice) throw PlatformError.conflict('Set the Availability base nightly price before Room Night administration');

    // Create absent rows in date order before locking the full range. Reservation operations use the same order.
    await repository.materializeRoomNights(context.tx, input.roomTypeId, dates, context.now);
    const current = await repository.lockRoomNights(context.tx, input.roomTypeId, dates);
    if (current.length !== dates.length) throw PlatformError.conflict('The Room Night range changed while it was being updated');

    for (const night of current) {
      const nextSellableUnits = input.sellableUnits ?? night.sellableUnits;
      if (nextSellableUnits < night.reservedUnits) {
        throw PlatformError.conflict(`Room Night ${night.localDate} has ${night.reservedUnits} reserved units`);
      }
    }

    for (const night of current) {
      const values: { sellableUnits?: number; nightlyPriceOverrideMinor?: number | null; updatedAt: Date } = { updatedAt: context.now };
      if (input.sellableUnits !== undefined) values.sellableUnits = input.sellableUnits;
      if (input.nightlyPriceOverrideMinor !== undefined) values.nightlyPriceOverrideMinor = input.nightlyPriceOverrideMinor;
      await repository.updateRoomNight(context.tx, input.roomTypeId, night.localDate, values);
    }
    return { updated: current.length };
  };
}
