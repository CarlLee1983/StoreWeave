import { randomUUID } from 'node:crypto';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import type { MediaReferencesPort } from '@storeweave/media';
import type { z } from 'zod';
import { BookingPropertyRepository, toPropertyDto, toRoomTypeDto } from './repository';
import {
  createRoomTypeInputSchema, propertyDtoSchema, propertyInputSchema, roomTypeDtoSchema,
  updateRoomTypeInputSchema,
} from './types';

const repository = new BookingPropertyRepository();

export const createPropertyCommand = defineCommand({
  name: 'booking.property.create', summary: '建立 Booking Property', input: propertyInputSchema,
  output: propertyDtoSchema, permission: 'booking-property:manage', idempotency: 'required',
  audit: { action: 'booking.property.created', resourceType: 'booking_property', resourceId: (_input, output: z.infer<typeof propertyDtoSchema>) => output.id },
});

export const updatePropertyCommand = defineCommand({
  name: 'booking.property.update', summary: '更新 Booking Property', input: propertyInputSchema,
  output: propertyDtoSchema, permission: 'booking-property:manage', idempotency: 'required',
  audit: { action: 'booking.property.updated', resourceType: 'booking_property', resourceId: () => 'singleton' },
});

export const createRoomTypeCommand = defineCommand({
  name: 'booking.property.createRoomType', summary: '建立 Booking Room Type', input: createRoomTypeInputSchema,
  output: roomTypeDtoSchema, permission: 'booking-property:manage', idempotency: 'required',
  audit: { action: 'booking.property.room-type-created', resourceType: 'booking_room_type', resourceId: (_input, output: z.infer<typeof roomTypeDtoSchema>) => output.id },
});

export const updateRoomTypeCommand = defineCommand({
  name: 'booking.property.updateRoomType', summary: '更新 Booking Room Type', input: updateRoomTypeInputSchema,
  output: roomTypeDtoSchema, permission: 'booking-property:manage', idempotency: 'required',
  audit: { action: 'booking.property.room-type-updated', resourceType: 'booking_room_type', resourceId: (input: z.infer<typeof updateRoomTypeInputSchema>) => input.roomTypeId },
});

export async function createPropertyHandler(input: z.infer<typeof propertyInputSchema>, context: CommandContext) {
  const row = await repository.insertProperty(context.tx, {
    id: randomUUID(), singletonSlot: 1, ...input, createdAt: context.now, updatedAt: context.now,
  });
  if (!row) throw PlatformError.conflict('This Booking release already has its Property');
  return toPropertyDto(row);
}

export async function updatePropertyHandler(input: z.infer<typeof propertyInputSchema>, context: CommandContext) {
  const row = await repository.updateProperty(context.tx, { ...input, updatedAt: context.now });
  if (!row) throw PlatformError.notFound('Booking Property', 'singleton');
  return toPropertyDto(row);
}

export function createRoomTypeHandler(mediaReferences: () => MediaReferencesPort | undefined) {
  return async (input: z.infer<typeof createRoomTypeInputSchema>, context: CommandContext) => {
    const property = await repository.getProperty(context.tx);
    if (!property) throw PlatformError.conflict('Create the Booking Property before its Room Types');
    const id = randomUUID();
    const row = await repository.insertRoomType(context.tx, {
      id, propertyId: property.id, status: 'active', ...input, createdAt: context.now, updatedAt: context.now,
    });
    if (!row) throw PlatformError.conflict(`Room Type code "${input.code}" is already in use`);
    const references = mediaReferences();
    if (!references) throw PlatformError.validation('Booking Property requires the Base Media reference capability');
    await references.replace(context.tx, { ownerType: 'booking.room-type', ownerId: id, mediaIds: input.mediaAssetId ? [input.mediaAssetId] : [] });
    return toRoomTypeDto(row);
  };
}

export function updateRoomTypeHandler(mediaReferences: () => MediaReferencesPort | undefined) {
  return async (input: z.infer<typeof updateRoomTypeInputSchema>, context: CommandContext) => {
    const current = await repository.lockRoomType(context.tx, input.roomTypeId);
    if (!current) throw PlatformError.notFound('Booking Room Type', input.roomTypeId);
    const references = mediaReferences();
    if (!references) throw PlatformError.validation('Booking Property requires the Base Media reference capability');
    await references.replace(context.tx, {
      ownerType: 'booking.room-type', ownerId: current.id, mediaIds: input.mediaAssetId ? [input.mediaAssetId] : [],
    });
    const { roomTypeId: _roomTypeId, ...facts } = input;
    const row = await repository.updateRoomType(context.tx, current.id, { ...facts, updatedAt: context.now });
    if (!row) throw PlatformError.notFound('Booking Room Type', current.id);
    return toRoomTypeDto(row);
  };
}
