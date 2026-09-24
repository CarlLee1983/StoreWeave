import { check, date, integer, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const bookingAvailabilityRoomTypePrices = pgTable('booking_availability_room_type_prices', {
  roomTypeId: uuid('room_type_id').primaryKey(),
  baseNightlyPriceMinor: integer('base_nightly_price_minor').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('booking_availability_room_type_base_price_check', sql`${table.baseNightlyPriceMinor} >= 0`),
]);

export const bookingAvailabilityRoomNights = pgTable('booking_availability_room_nights', {
  roomTypeId: uuid('room_type_id').notNull()
    .references(() => bookingAvailabilityRoomTypePrices.roomTypeId, { onDelete: 'restrict' }),
  localDate: date('local_date', { mode: 'string' }).notNull(),
  sellableUnits: integer('sellable_units').notNull(),
  reservedUnits: integer('reserved_units').notNull().default(0),
  nightlyPriceOverrideMinor: integer('nightly_price_override_minor'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ name: 'booking_availability_room_nights_pk', columns: [table.roomTypeId, table.localDate] }),
  check('booking_availability_room_night_sellable_units_check', sql`${table.sellableUnits} >= 0`),
  check('booking_availability_room_night_reserved_units_check', sql`${table.reservedUnits} >= 0`),
  check('booking_availability_room_night_override_check', sql`${table.nightlyPriceOverrideMinor} IS NULL OR ${table.nightlyPriceOverrideMinor} >= 0`),
  check('booking_availability_room_night_capacity_check', sql`${table.sellableUnits} >= ${table.reservedUnits}`),
]);

export type BookingAvailabilityRoomTypePriceRow = typeof bookingAvailabilityRoomTypePrices.$inferSelect;
export type BookingAvailabilityRoomNightRow = typeof bookingAvailabilityRoomNights.$inferSelect;
