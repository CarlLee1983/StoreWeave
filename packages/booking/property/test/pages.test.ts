import { describe, expect, it } from 'vitest';
import type { PageResolveContext } from '@storeweave/kernel';
import { createBookingPropertyModule } from '../src/module';
import { bookingPropertyPages } from '../src/pages';
import { getActiveRoomTypeQuery, getPublicPropertyQuery, listActiveRoomTypesQuery } from '../src/queries';

const property = {
  id: 'f231e130-5cdf-4e2e-9d01-4e669aebac3e', name: '海岸旅宿',
  address: {
    countryCode: 'TW', postalCode: '970', administrativeArea: '花蓮縣', locality: '花蓮市',
    addressLine1: '中山路 1 號', addressLine2: null,
  },
  timezone: 'Asia/Taipei', currency: 'TWD', checkInTime: '15:00', checkOutTime: '11:00',
  defaultPolicy: { freeCancellationHoursBeforeCheckIn: 48 },
  createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const roomType = {
  id: 'f231e130-5cdf-4e2e-9d01-4e669aebac3e', code: 'sea-view', name: '海景雙人房',
  description: '面向太平洋的雙人房。', maxOccupancyPerUnit: 2,
  beds: [{ type: 'queen' as const, count: 1 }], amenities: [{ code: 'wifi', label: '無線網路' }],
  minimumStayNights: 1, maximumStayNights: null, mediaAssetId: null, status: 'active' as const,
  createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function pageContext(results: Readonly<Record<string, unknown>>): PageResolveContext {
  return {
    queries: { execute: async <O>(name: string) => results[name] as O },
    commands: { execute: async <O>() => undefined as O },
    actor: { type: 'service', id: 'storefront', permissions: [] },
    locale: 'zh-TW', clientKey: 'client-key',
    cookies: { guestCartToken: () => null, ensureGuestCart: () => 'token' },
    providers: { get: <T>() => undefined as T, has: () => false },
  };
}

describe('Booking Property storefront page declarations', () => {
  it('registers the three stable public pages and their safe query descriptors', () => {
    const module = createBookingPropertyModule();
    expect(Object.keys(module.pages ?? {}).sort()).toEqual(['property', 'roomType', 'roomTypes']);
    expect(Object.values(module.pages ?? {}).map(page => [page.id, page.path, page.audience])).toEqual([
      ['booking.property.property', '/property', 'public'],
      ['booking.property.roomTypes', '/rooms', 'public'],
      ['booking.property.roomType', '/rooms/:roomTypeId', 'public'],
    ]);
    expect(getPublicPropertyQuery.permission).toBe('booking-property:public-read');
    expect(listActiveRoomTypesQuery.permission).toBe('booking-property:public-read');
    expect(getActiveRoomTypeQuery.permission).toBe('booking-property:public-read');
  });

  it('resolves only public Property facts and active Room Types through declared queries', async () => {
    const ctx = pageContext({
      'booking.property.getPublicProperty': property,
      'booking.property.listActiveRoomTypes': [roomType],
      'booking.property.getActiveRoomType': roomType,
    });
    const propertyResult = await bookingPropertyPages.property.resolve(ctx, {});
    const listResult = await bookingPropertyPages.roomTypes.resolve(ctx, {});
    const detailResult = await bookingPropertyPages.roomType.resolve(ctx, { roomTypeId: roomType.id });

    expect(propertyResult).toEqual({ kind: 'view', view: { property } });
    expect(listResult).toEqual({ kind: 'view', view: { property, roomTypes: [roomType] } });
    expect(detailResult).toEqual({ kind: 'view', view: { property, roomType } });
    expect(bookingPropertyPages.roomType.input.safeParse({ roomTypeId: 'not-a-uuid' }).success).toBe(false);
  });

  it('does not expose a missing Property or inactive Room Type as a public page', async () => {
    const ctx = pageContext({
      'booking.property.getPublicProperty': null,
      'booking.property.listActiveRoomTypes': [],
      'booking.property.getActiveRoomType': null,
    });
    expect(await bookingPropertyPages.property.resolve(ctx, {})).toEqual({ kind: 'not-found' });
    expect(await bookingPropertyPages.roomTypes.resolve(ctx, {})).toEqual({ kind: 'not-found' });
    expect(await bookingPropertyPages.roomType.resolve(ctx, { roomTypeId: roomType.id })).toEqual({ kind: 'not-found' });
  });
});
