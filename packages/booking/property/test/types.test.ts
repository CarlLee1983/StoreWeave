import { describe, expect, it } from 'vitest';
import { propertyInputSchema, roomTypeFactsSchema, updateRoomTypeInputSchema } from '../src/types';

const validProperty = {
  name: '山城旅店',
  address: {
    countryCode: 'TW', postalCode: '400', administrativeArea: '臺中市', locality: '中區',
    addressLine1: '自由路 1 號', addressLine2: null,
  },
  timezone: 'Asia/Taipei', currency: 'TWD', checkInTime: '15:00', checkOutTime: '11:00',
  defaultPolicy: { freeCancellationHoursBeforeCheckIn: 24 },
};

const validRoomType = {
  code: 'mountain-double', name: '山景雙人房', description: null, maxOccupancyPerUnit: 2,
  beds: [{ type: 'queen', count: 1 }], amenities: [{ code: 'wifi', label: '無線網路' }],
  minimumStayNights: 1, maximumStayNights: null, mediaAssetId: null,
};

describe('Booking Property input contracts', () => {
  it('accepts structured property, bed, amenity, and cancellation-window facts', () => {
    expect(propertyInputSchema.parse(validProperty)).toMatchObject(validProperty);
    expect(roomTypeFactsSchema.parse(validRoomType)).toMatchObject(validRoomType);
  });

  it('rejects malformed timezone, currency, identical check-in/out, and unknown fields', () => {
    expect(propertyInputSchema.safeParse({ ...validProperty, timezone: 'Mars/Olympus_Mons' }).success).toBe(false);
    expect(propertyInputSchema.safeParse({ ...validProperty, currency: 'ZZZ' }).success).toBe(false);
    expect(propertyInputSchema.safeParse({ ...validProperty, checkOutTime: '15:00' }).success).toBe(false);
    expect(propertyInputSchema.safeParse({ ...validProperty, contentId: 'commerce-content' }).success).toBe(false);
  });

  it('keeps occupancy as a Room Type fact, rejects inventory fields, and preserves stable code on updates', () => {
    expect(roomTypeFactsSchema.safeParse({ ...validRoomType, sellableUnits: 4 }).success).toBe(false);
    expect(updateRoomTypeInputSchema.safeParse({ ...validRoomType, roomTypeId: 'f231e130-5cdf-4e2e-9d01-4e669aebac3e', status: 'active' }).success).toBe(false);
    expect(roomTypeFactsSchema.safeParse({ ...validRoomType, maximumStayNights: 0 }).success).toBe(false);
    expect(roomTypeFactsSchema.safeParse({ ...validRoomType, minimumStayNights: 5, maximumStayNights: 2 }).success).toBe(false);
  });
});
