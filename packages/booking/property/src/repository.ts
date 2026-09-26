import { and, asc, eq } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { bookingProperties, bookingRoomTypes, type BookingPropertyRow, type BookingRoomTypeRow } from './schema';
import type { PropertyDto, RoomTypeDto } from './types';

const SINGLETON_SLOT = 1;

export function toPropertyDto(row: BookingPropertyRow): PropertyDto {
  return {
    id: row.id, name: row.name, address: row.address, timezone: row.timezone, currency: row.currency,
    checkInTime: row.checkInTime, checkOutTime: row.checkOutTime, defaultPolicy: row.defaultPolicy,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

export function toRoomTypeDto(row: BookingRoomTypeRow): RoomTypeDto {
  return {
    id: row.id, code: row.code, name: row.name, description: row.description, status: row.status as RoomTypeDto['status'],
    maxOccupancyPerUnit: row.maxOccupancyPerUnit, beds: row.beds, amenities: row.amenities,
    minimumStayNights: row.minimumStayNights, maximumStayNights: row.maximumStayNights,
    mediaAssetId: row.mediaAssetId, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

export class BookingPropertyRepository {
  async hasActiveMedia(db: DrizzleDb | Tx, mediaAssetId: string): Promise<boolean> {
    const rows = await db.select({ id: bookingRoomTypes.id }).from(bookingRoomTypes)
      .where(and(eq(bookingRoomTypes.status, 'active'), eq(bookingRoomTypes.mediaAssetId, mediaAssetId))).limit(1);
    return rows.length !== 0;
  }

  async getProperty(db: DrizzleDb | Tx): Promise<BookingPropertyRow | null> {
    const [row] = await db.select().from(bookingProperties).where(eq(bookingProperties.singletonSlot, SINGLETON_SLOT)).limit(1);
    return row ?? null;
  }

  async lockProperty(tx: Tx): Promise<BookingPropertyRow | null> {
    const [row] = await tx.select().from(bookingProperties)
      .where(eq(bookingProperties.singletonSlot, SINGLETON_SLOT)).limit(1).for('update');
    return row ?? null;
  }

  async insertProperty(tx: Tx, values: typeof bookingProperties.$inferInsert): Promise<BookingPropertyRow | null> {
    const [row] = await tx.insert(bookingProperties).values(values)
      .onConflictDoNothing({ target: bookingProperties.singletonSlot }).returning();
    return row ?? null;
  }

  async updateProperty(tx: Tx, values: Omit<typeof bookingProperties.$inferInsert, 'id' | 'singletonSlot' | 'createdAt'>): Promise<BookingPropertyRow | null> {
    const [row] = await tx.update(bookingProperties).set(values)
      .where(eq(bookingProperties.singletonSlot, SINGLETON_SLOT)).returning();
    return row ?? null;
  }

  async getRoomType(db: DrizzleDb | Tx, id: string): Promise<BookingRoomTypeRow | null> {
    const [row] = await db.select().from(bookingRoomTypes).where(eq(bookingRoomTypes.id, id)).limit(1);
    return row ?? null;
  }

  async lockRoomType(tx: Tx, id: string): Promise<BookingRoomTypeRow | null> {
    const [row] = await tx.select().from(bookingRoomTypes).where(eq(bookingRoomTypes.id, id)).limit(1).for('update');
    return row ?? null;
  }

  async insertRoomType(tx: Tx, values: typeof bookingRoomTypes.$inferInsert): Promise<BookingRoomTypeRow | null> {
    const [row] = await tx.insert(bookingRoomTypes).values(values)
      .onConflictDoNothing({ target: bookingRoomTypes.code }).returning();
    return row ?? null;
  }

  async updateRoomType(tx: Tx, id: string, values: Omit<typeof bookingRoomTypes.$inferInsert, 'id' | 'code' | 'propertyId' | 'createdAt'>): Promise<BookingRoomTypeRow | null> {
    const [row] = await tx.update(bookingRoomTypes).set(values).where(eq(bookingRoomTypes.id, id)).returning();
    return row ?? null;
  }

  async listRoomTypes(db: DrizzleDb | Tx, status?: 'active'): Promise<BookingRoomTypeRow[]> {
    const query = db.select().from(bookingRoomTypes);
    return status
      ? query.where(eq(bookingRoomTypes.status, status)).orderBy(asc(bookingRoomTypes.name), asc(bookingRoomTypes.id))
      : query.orderBy(asc(bookingRoomTypes.name), asc(bookingRoomTypes.id));
  }
}
