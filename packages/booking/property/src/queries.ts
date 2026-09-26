import { z } from 'zod';
import { defineQuery, PlatformError, type QueryContext } from '@storeweave/contracts';
import { BookingPropertyRepository, toPropertyDto, toRoomTypeDto } from './repository';
import { bookingPropertyRead } from './service';
import { propertyDtoSchema, roomTypeDtoSchema } from './types';

const repository = new BookingPropertyRepository();
const emptyInput = z.object({}).strict();

export const getPublicMediaQuery = defineQuery({
  name: 'booking.property.getPublicMedia', summary: '確認公開房型圖片引用',
  input: z.object({ mediaAssetId: z.string().uuid() }).strict(),
  output: z.object({ mediaAssetId: z.string().uuid() }).strict(), permission: 'booking-property:public-read',
});
export const getPublicMediaHandler = async (input: { mediaAssetId: string }, context: QueryContext) => {
  if (!await repository.hasActiveMedia(context.db, input.mediaAssetId)) throw PlatformError.notFound('Booking media', input.mediaAssetId);
  return { mediaAssetId: input.mediaAssetId };
};

export const getPropertyQuery = defineQuery({
  name: 'booking.property.getProperty', summary: '讀取 Booking Property', input: emptyInput,
  output: propertyDtoSchema.nullable(), permission: 'booking-property:read',
});
export const getPublicPropertyQuery = defineQuery({
  name: 'booking.property.getPublicProperty', summary: '讀取公開 Booking Property', input: emptyInput,
  output: propertyDtoSchema.nullable(), permission: 'booking-property:public-read',
});
export const listActiveRoomTypesQuery = defineQuery({
  name: 'booking.property.listActiveRoomTypes', summary: '列出可預訂的 Booking Room Types', input: emptyInput,
  output: z.array(roomTypeDtoSchema), permission: 'booking-property:public-read',
});
export const listRoomTypesQuery = defineQuery({
  name: 'booking.property.listRoomTypes', summary: '列出所有 Booking Room Types', input: emptyInput,
  output: z.array(roomTypeDtoSchema), permission: 'booking-property:manage',
});
export const getRoomTypeQuery = defineQuery({
  name: 'booking.property.getRoomType', summary: '讀取 Booking Room Type',
  input: z.object({ roomTypeId: z.string().uuid() }).strict(),
  output: roomTypeDtoSchema.nullable(), permission: 'booking-property:manage',
});
export const getActiveRoomTypeQuery = defineQuery({
  name: 'booking.property.getActiveRoomType', summary: '讀取公開 Booking Room Type',
  input: z.object({ roomTypeId: z.string().uuid() }).strict(),
  output: roomTypeDtoSchema.nullable(), permission: 'booking-property:public-read',
});

export const getPropertyHandler = async (_input: unknown, context: QueryContext) => bookingPropertyRead.getProperty(context.db);
export const getPublicPropertyHandler = getPropertyHandler;
export const listActiveRoomTypesHandler = async (_input: unknown, context: QueryContext) => bookingPropertyRead.listActiveRoomTypes(context.db);
export const listRoomTypesHandler = async (_input: unknown, context: QueryContext) =>
  (await repository.listRoomTypes(context.db)).map(toRoomTypeDto);
export const getRoomTypeHandler = async (input: { roomTypeId: string }, context: QueryContext) => {
  const row = await repository.getRoomType(context.db, input.roomTypeId);
  return row ? toRoomTypeDto(row) : null;
};
export const getActiveRoomTypeHandler = async (input: { roomTypeId: string }, context: QueryContext) =>
  bookingPropertyRead.getActiveRoomType(context.db, input.roomTypeId);
