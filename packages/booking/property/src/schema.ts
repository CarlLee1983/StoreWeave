import { check, integer, jsonb, pgTable, smallint, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { PropertyAddress, PropertyDefaultPolicy, RoomTypeFacts } from './types';

export const bookingProperties = pgTable('booking_property_properties', {
  id: uuid('id').primaryKey(),
  singletonSlot: smallint('singleton_slot').notNull().default(1),
  name: text('name').notNull(),
  address: jsonb('address').$type<PropertyAddress>().notNull(),
  timezone: text('timezone').notNull(),
  currency: text('currency').notNull(),
  checkInTime: text('check_in_time').notNull(),
  checkOutTime: text('check_out_time').notNull(),
  defaultPolicy: jsonb('default_policy').$type<PropertyDefaultPolicy>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('booking_property_singleton_unique').on(table.singletonSlot),
  check('booking_property_singleton_slot_check', sql`${table.singletonSlot} = 1`),
  check('booking_property_currency_check', sql`${table.currency} ~ '^[A-Z]{3}$'`),
  check('booking_property_check_in_time_check', sql`${table.checkInTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
  check('booking_property_check_out_time_check', sql`${table.checkOutTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
  check('booking_property_distinct_times_check', sql`${table.checkInTime} <> ${table.checkOutTime}`),
]);

export const bookingRoomTypes = pgTable('booking_property_room_types', {
  id: uuid('id').primaryKey(),
  propertyId: uuid('property_id').notNull().references(() => bookingProperties.id, { onDelete: 'restrict' }),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull().default('active'),
  maxOccupancyPerUnit: integer('max_occupancy_per_unit').notNull(),
  beds: jsonb('beds').$type<RoomTypeFacts['beds']>().notNull(),
  amenities: jsonb('amenities').$type<RoomTypeFacts['amenities']>().notNull(),
  minimumStayNights: integer('minimum_stay_nights').notNull().default(1),
  maximumStayNights: integer('maximum_stay_nights'),
  mediaAssetId: uuid('media_asset_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('booking_property_room_type_status_check', sql`${table.status} IN ('active', 'disabled')`),
  check('booking_property_room_type_occupancy_check', sql`${table.maxOccupancyPerUnit} BETWEEN 1 AND 32`),
  check('booking_property_room_type_beds_check', sql`jsonb_typeof(${table.beds}) = 'array'`),
  check('booking_property_room_type_amenities_check', sql`jsonb_typeof(${table.amenities}) = 'array'`),
  check('booking_property_room_type_minimum_stay_check', sql`${table.minimumStayNights} BETWEEN 1 AND 30`),
  check('booking_property_room_type_maximum_stay_check', sql`${table.maximumStayNights} IS NULL OR ${table.maximumStayNights} BETWEEN ${table.minimumStayNights} AND 30`),
]);

export type BookingPropertyRow = typeof bookingProperties.$inferSelect;
export type BookingRoomTypeRow = typeof bookingRoomTypes.$inferSelect;
