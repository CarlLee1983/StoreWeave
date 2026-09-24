import { z } from 'zod';
import { definePage, type PageOutcome, type PageResolveContext, type StorefrontHttpContract } from '@storeweave/kernel';
import type { PropertyDto, RoomTypeDto } from './types';

const htmlResponses: StorefrontHttpContract['responses'] = [
  { kind: 'html', status: 200, contentType: 'text/html; charset=utf-8', body: 'theme' },
  { kind: 'html', status: 'platform-error', contentType: 'text/html; charset=utf-8', body: 'theme' },
];

export interface BookingPropertyView {
  readonly property: PropertyDto;
}

export interface BookingRoomTypeListView {
  readonly property: PropertyDto;
  readonly roomTypes: readonly RoomTypeDto[];
}

export interface BookingRoomTypeDetailView {
  readonly property: PropertyDto;
  readonly roomType: RoomTypeDto;
}

async function getPublicProperty(ctx: PageResolveContext): Promise<PropertyDto | null> {
  return ctx.queries.execute<PropertyDto | null>(
    'booking.property.getPublicProperty', {}, { actor: ctx.actor },
  );
}

export const bookingPropertyPages = {
  property: definePage({
    id: 'booking.property.property',
    path: '/property',
    method: 'get',
    audience: 'public',
    input: z.object({}).strict(),
    contract: {
      kind: 'storefront', request: 'none',
      input: { type: 'object', properties: {}, additionalProperties: false },
      responses: htmlResponses,
    },
    resolve: async (ctx): Promise<PageOutcome<BookingPropertyView>> => {
      const property = await getPublicProperty(ctx);
      return property ? { kind: 'view', view: { property } } : { kind: 'not-found' };
    },
  }),

  roomTypes: definePage({
    id: 'booking.property.roomTypes',
    path: '/rooms',
    method: 'get',
    audience: 'public',
    input: z.object({}).strict(),
    contract: {
      kind: 'storefront', request: 'none',
      input: { type: 'object', properties: {}, additionalProperties: false },
      responses: htmlResponses,
    },
    resolve: async (ctx): Promise<PageOutcome<BookingRoomTypeListView>> => {
      const [property, roomTypes] = await Promise.all([
        getPublicProperty(ctx),
        ctx.queries.execute<RoomTypeDto[]>(
          'booking.property.listActiveRoomTypes', {}, { actor: ctx.actor },
        ),
      ]);
      return property ? { kind: 'view', view: { property, roomTypes } } : { kind: 'not-found' };
    },
  }),

  roomType: definePage({
    id: 'booking.property.roomType',
    path: '/rooms/:roomTypeId',
    method: 'get',
    audience: 'public',
    input: z.object({ roomTypeId: z.string().uuid() }).strict(),
    contract: {
      kind: 'storefront', request: 'none',
      input: {
        type: 'object', required: ['roomTypeId'],
        properties: { roomTypeId: { type: 'string', format: 'uuid' } },
        additionalProperties: false,
      },
      params: { roomTypeId: 'roomTypeId' },
      responses: htmlResponses,
    },
    resolve: async (ctx, { roomTypeId }): Promise<PageOutcome<BookingRoomTypeDetailView>> => {
      const [property, roomType] = await Promise.all([
        getPublicProperty(ctx),
        ctx.queries.execute<RoomTypeDto | null>(
          'booking.property.getActiveRoomType', { roomTypeId }, { actor: ctx.actor },
        ),
      ]);
      return property && roomType ? { kind: 'view', view: { property, roomType } } : { kind: 'not-found' };
    },
  }),
} as const;

export type BookingPropertyPages = typeof bookingPropertyPages;
