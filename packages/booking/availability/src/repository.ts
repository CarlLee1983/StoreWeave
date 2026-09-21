import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import {
  bookingAvailabilityRoomNights, bookingAvailabilityRoomTypePrices,
  type BookingAvailabilityRoomNightRow, type BookingAvailabilityRoomTypePriceRow,
} from './schema';

export class BookingAvailabilityRepository {
  async getBasePrice(db: DrizzleDb | Tx, roomTypeId: string): Promise<BookingAvailabilityRoomTypePriceRow | null> {
    const [row] = await db.select().from(bookingAvailabilityRoomTypePrices)
      .where(eq(bookingAvailabilityRoomTypePrices.roomTypeId, roomTypeId)).limit(1);
    return row ?? null;
  }

  async lockBasePrice(tx: Tx, roomTypeId: string): Promise<BookingAvailabilityRoomTypePriceRow | null> {
    const [row] = await tx.select().from(bookingAvailabilityRoomTypePrices)
      .where(eq(bookingAvailabilityRoomTypePrices.roomTypeId, roomTypeId)).limit(1).for('update');
    return row ?? null;
  }

  async setBasePrice(tx: Tx, roomTypeId: string, baseNightlyPriceMinor: number, updatedAt: Date): Promise<BookingAvailabilityRoomTypePriceRow> {
    const [row] = await tx.insert(bookingAvailabilityRoomTypePrices).values({
      roomTypeId, baseNightlyPriceMinor, createdAt: updatedAt, updatedAt,
    }).onConflictDoUpdate({
      target: bookingAvailabilityRoomTypePrices.roomTypeId,
      set: { baseNightlyPriceMinor, updatedAt },
    }).returning();
    return row!;
  }

  async materializeRoomNights(tx: Tx, roomTypeId: string, dates: readonly string[], now: Date): Promise<void> {
    await tx.insert(bookingAvailabilityRoomNights).values(dates.map(localDate => ({
      roomTypeId, localDate, sellableUnits: 0, reservedUnits: 0,
      nightlyPriceOverrideMinor: null, createdAt: now, updatedAt: now,
    }))).onConflictDoNothing({
      target: [bookingAvailabilityRoomNights.roomTypeId, bookingAvailabilityRoomNights.localDate],
    });
  }

  /** Operations spanning at most 30 nights materialize unique rows one at a time in lock order. */
  async materializeRoomNightsInDateOrder(tx: Tx, roomTypeId: string, dates: readonly string[], now: Date): Promise<void> {
    const orderedDates = [...new Set(dates)].sort();
    for (const localDate of orderedDates) {
      await tx.insert(bookingAvailabilityRoomNights).values({
        roomTypeId, localDate, sellableUnits: 0, reservedUnits: 0,
        nightlyPriceOverrideMinor: null, createdAt: now, updatedAt: now,
      }).onConflictDoNothing({
        target: [bookingAvailabilityRoomNights.roomTypeId, bookingAvailabilityRoomNights.localDate],
      });
    }
  }

  async lockRoomNights(tx: Tx, roomTypeId: string, dates: readonly string[]): Promise<BookingAvailabilityRoomNightRow[]> {
    return tx.select().from(bookingAvailabilityRoomNights).where(and(
      eq(bookingAvailabilityRoomNights.roomTypeId, roomTypeId),
      inArray(bookingAvailabilityRoomNights.localDate, [...dates]),
    )).orderBy(asc(bookingAvailabilityRoomNights.localDate)).for('update');
  }

  async updateRoomNight(
    tx: Tx,
    roomTypeId: string,
    localDate: string,
    values: Partial<Pick<typeof bookingAvailabilityRoomNights.$inferInsert, 'sellableUnits' | 'nightlyPriceOverrideMinor'>> & { updatedAt: Date },
  ): Promise<void> {
    await tx.update(bookingAvailabilityRoomNights).set(values).where(and(
      eq(bookingAvailabilityRoomNights.roomTypeId, roomTypeId),
      eq(bookingAvailabilityRoomNights.localDate, localDate),
    ));
  }

  async adjustReservedUnits(
    tx: Tx,
    roomTypeId: string,
    dates: readonly string[],
    delta: number,
    updatedAt: Date,
  ): Promise<number> {
    const updated = await tx.update(bookingAvailabilityRoomNights).set({
      reservedUnits: sql`${bookingAvailabilityRoomNights.reservedUnits} + ${delta}`,
      updatedAt,
    }).where(and(
      eq(bookingAvailabilityRoomNights.roomTypeId, roomTypeId),
      inArray(bookingAvailabilityRoomNights.localDate, [...dates]),
    )).returning({ localDate: bookingAvailabilityRoomNights.localDate });
    return updated.length;
  }

  async listRoomNights(db: DrizzleDb | Tx, roomTypeId: string, startLocalDate: string, endLocalDateExclusive: string): Promise<BookingAvailabilityRoomNightRow[]> {
    return db.select().from(bookingAvailabilityRoomNights).where(and(
      eq(bookingAvailabilityRoomNights.roomTypeId, roomTypeId),
      gte(bookingAvailabilityRoomNights.localDate, startLocalDate),
      lt(bookingAvailabilityRoomNights.localDate, endLocalDateExclusive),
    )).orderBy(asc(bookingAvailabilityRoomNights.localDate));
  }

  async loadQuoteSnapshot(db: DrizzleDb | Tx, roomTypeId: string, startLocalDate: string, endLocalDateExclusive: string) {
    return db.select({
      baseNightlyPriceMinor: bookingAvailabilityRoomTypePrices.baseNightlyPriceMinor,
      localDate: bookingAvailabilityRoomNights.localDate,
      sellableUnits: bookingAvailabilityRoomNights.sellableUnits,
      reservedUnits: bookingAvailabilityRoomNights.reservedUnits,
      nightlyPriceOverrideMinor: bookingAvailabilityRoomNights.nightlyPriceOverrideMinor,
    }).from(bookingAvailabilityRoomTypePrices).leftJoin(bookingAvailabilityRoomNights, and(
      eq(bookingAvailabilityRoomNights.roomTypeId, bookingAvailabilityRoomTypePrices.roomTypeId),
      gte(bookingAvailabilityRoomNights.localDate, startLocalDate),
      lt(bookingAvailabilityRoomNights.localDate, endLocalDateExclusive),
    )).where(eq(bookingAvailabilityRoomTypePrices.roomTypeId, roomTypeId))
      .orderBy(asc(bookingAvailabilityRoomNights.localDate));
  }
}
