import { check, date, integer, jsonb, pgTable, smallint, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const diningVenues = pgTable('dining_reservation_venues', {
  id: uuid('id').primaryKey(),
  singletonSlot: smallint('singleton_slot').notNull().default(1),
  name: text('name').notNull(),
  timezone: text('timezone').notNull(),
  occupancyMinutes: integer('occupancy_minutes').notNull().default(90),
  minAdvanceMinutes: integer('min_advance_minutes').notNull().default(60),
  maxAdvanceDays: integer('max_advance_days').notNull().default(30),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('dining_reservation_singleton_unique').on(table.singletonSlot),
  check('dining_reservation_singleton_check', sql`${table.singletonSlot} = 1`),
  check('dining_reservation_window_check', sql`${table.minAdvanceMinutes} BETWEEN 1 AND 525600 AND ${table.maxAdvanceDays} BETWEEN 1 AND 365 AND ${table.minAdvanceMinutes} <= ${table.maxAdvanceDays} * 1440`),
  check('dining_reservation_duration_check', sql`${table.occupancyMinutes} BETWEEN 1 AND 1440`),
]);

export const diningTableTypes = pgTable('dining_reservation_table_types', {
  id: uuid('id').primaryKey(),
  venueId: uuid('venue_id').notNull().references(() => diningVenues.id),
  capacity: integer('capacity').notNull().unique(),
  count: integer('table_count').notNull(),
  active: smallint('active').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('dining_reservation_table_capacity_check', sql`${table.capacity} BETWEEN 1 AND 1000`),
  check('dining_reservation_table_count_check', sql`${table.count} BETWEEN 0 AND 10000`),
  check('dining_reservation_table_active_check', sql`${table.active} IN (0, 1)`),
  check('dining_reservation_table_disabled_count_check', sql`${table.active} = 1 OR ${table.count} = 0`),
]);

export const diningWeeklyStarts = pgTable('dining_reservation_weekly_starts', {
  venueId: uuid('venue_id').notNull().references(() => diningVenues.id),
  weekday: smallint('weekday').notNull().primaryKey(),
  startTimes: jsonb('start_times').$type<string[]>().notNull(),
});

export const diningDateOverrides = pgTable('dining_reservation_date_overrides', {
  venueId: uuid('venue_id').notNull().references(() => diningVenues.id),
  date: date('start_date').notNull().primaryKey(),
  startTimes: jsonb('start_times').$type<string[]>().notNull(),
});

export const diningRequestSnapshots = pgTable('dining_reservation_request_snapshots', {
  id: uuid('id').primaryKey(),
  venueId: uuid('venue_id').notNull().references(() => diningVenues.id),
  startAt: timestamp('start_at', { withTimezone: true }).notNull(),
  endAt: timestamp('end_at', { withTimezone: true }).notNull(),
  startDate: date('start_date').notNull(),
  startTime: text('start_time').notNull(),
  timezone: text('timezone').notNull(),
  partySize: integer('party_size').notNull(),
  occupancyMinutes: integer('occupancy_minutes').notNull(),
  minAdvanceMinutes: integer('min_advance_minutes').notNull(),
  maxAdvanceDays: integer('max_advance_days').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const diningCapacityCommitments = pgTable('dining_reservation_capacity_commitments', {
  requestId: uuid('request_id').primaryKey().references(() => diningRequestSnapshots.id),
  tableTypeId: uuid('table_type_id').notNull().references(() => diningTableTypes.id),
  tableTypeCapacity: integer('table_type_capacity').notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
}, table => [
  check('dining_reservation_commitment_capacity_check', sql`${table.tableTypeCapacity} BETWEEN 1 AND 1000`),
  check('dining_reservation_commitment_cancel_check', sql`${table.cancelledAt} IS NULL OR ${table.cancelledAt} >= ${table.acceptedAt}`),
]);
