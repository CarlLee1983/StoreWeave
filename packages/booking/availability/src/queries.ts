import { z } from 'zod';
import { defineQuery, type QueryContext } from '@storeweave/contracts';
import { BookingAvailabilityRepository } from './repository';
import {
  getRoomNightRangeInputSchema, localDateRange, roomNightRangeViewSchema,
  type BookingPropertyLookup,
} from './types';

const repository = new BookingAvailabilityRepository();

export const getRoomNightRangeQuery = defineQuery({
  name: 'booking.availability.getRoomNightRange',
  summary: '讀取 Room Type 的逐日供應與有效每晚價格',
  input: getRoomNightRangeInputSchema,
  output: roomNightRangeViewSchema.nullable(),
  permission: 'booking-availability:read',
});

export function createGetRoomNightRangeHandler(properties: BookingPropertyLookup) {
  return async (input: z.infer<typeof getRoomNightRangeInputSchema>, context: QueryContext) => {
    const [property, roomType, basePrice, storedNights] = await Promise.all([
      properties.getProperty(context.db),
      properties.getActiveRoomType(context.db, input.roomTypeId),
      repository.getBasePrice(context.db, input.roomTypeId),
      repository.listRoomNights(context.db, input.roomTypeId, input.startLocalDate, input.endLocalDateExclusive),
    ]);
    if (!roomType || !property) return null;

    const storedByDate = new Map(storedNights.map(night => [night.localDate, night]));
    const baseNightlyPriceMinor = basePrice?.baseNightlyPriceMinor ?? null;
    return {
      roomTypeId: input.roomTypeId,
      propertyTimeZone: property.timezone,
      currency: property.currency,
      baseNightlyPriceMinor,
      nights: localDateRange(input.startLocalDate, input.endLocalDateExclusive).map(localDate => {
        const night = storedByDate.get(localDate);
        const override = night?.nightlyPriceOverrideMinor ?? null;
        return {
          localDate,
          sellableUnits: night?.sellableUnits ?? 0,
          reservedUnits: night?.reservedUnits ?? 0,
          nightlyPriceOverrideMinor: override,
          effectiveNightlyPriceMinor: override ?? baseNightlyPriceMinor,
        };
      }),
    };
  };
}
