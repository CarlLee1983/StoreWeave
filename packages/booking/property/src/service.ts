import { PlatformError, type DrizzleDb, type Tx } from '@storeweave/contracts';
import { z } from 'zod';
import { BookingPropertyRepository, toPropertyDto, toRoomTypeDto } from './repository';
import type { PropertyDto, RoomTypeDto } from './types';

export type BookingPropertyQuoteFacts = Readonly<{
  property: Readonly<Pick<PropertyDto, 'id' | 'timezone' | 'currency' | 'checkInTime'>> & {
    readonly defaultPolicy: Readonly<Pick<PropertyDto['defaultPolicy'], 'freeCancellationHoursBeforeCheckIn'>>;
  };
  roomType: Readonly<Pick<RoomTypeDto, 'id' | 'maxOccupancyPerUnit' | 'minimumStayNights' | 'maximumStayNights'>>;
}>;

export interface BookingPropertyReadCapability {
  getProperty(db: DrizzleDb | Tx): Promise<PropertyDto | null>;
  getActiveRoomType(db: DrizzleDb | Tx, roomTypeId: string): Promise<RoomTypeDto | null>;
  listActiveRoomTypes(db: DrizzleDb | Tx): Promise<readonly RoomTypeDto[]>;
  requireLockedQuoteFacts(tx: Tx, roomTypeId: string): Promise<BookingPropertyQuoteFacts>;
}

const repository = new BookingPropertyRepository();
const roomTypeIdSchema = z.string().uuid();

/** Read-only Booking lodging facts; every lookup uses the caller's transaction when supplied. */
export const bookingPropertyRead: BookingPropertyReadCapability = Object.freeze({
  async getProperty(db: DrizzleDb | Tx) {
    const row = await repository.getProperty(db);
    return row ? toPropertyDto(row) : null;
  },
  async getActiveRoomType(db: DrizzleDb | Tx, roomTypeId: string) {
    const row = await repository.getRoomType(db, roomTypeId);
    return row?.status === 'active' ? toRoomTypeDto(row) : null;
  },
  async listActiveRoomTypes(db: DrizzleDb | Tx) {
    return (await repository.listRoomTypes(db, 'active')).map(toRoomTypeDto);
  },
  async requireLockedQuoteFacts(tx: Tx, roomTypeId: string): Promise<BookingPropertyQuoteFacts> {
    const parsedId = roomTypeIdSchema.safeParse(roomTypeId);
    if (!parsedId.success) throw PlatformError.validation('Invalid Booking Room Type id', parsedId.error.issues);

    const property = await repository.lockProperty(tx);
    if (!property) throw PlatformError.conflict('Booking Property is not configured');
    const roomType = await repository.lockRoomType(tx, parsedId.data);
    if (!roomType || roomType.status !== 'active') throw PlatformError.notFound('Active Room Type', parsedId.data);

    return Object.freeze({
      property: Object.freeze({
        id: property.id,
        timezone: property.timezone,
        currency: property.currency,
        checkInTime: property.checkInTime,
        defaultPolicy: Object.freeze({
          freeCancellationHoursBeforeCheckIn: property.defaultPolicy.freeCancellationHoursBeforeCheckIn,
        }),
      }),
      roomType: Object.freeze({
        id: roomType.id,
        maxOccupancyPerUnit: roomType.maxOccupancyPerUnit,
        minimumStayNights: roomType.minimumStayNights,
        maximumStayNights: roomType.maximumStayNights,
      }),
    });
  },
});
