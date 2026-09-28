import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import { diningDateOverrides, diningRequestSnapshots, diningTableTypes, diningVenues, diningWeeklyStarts } from './schema';
import { DiningReservationRepository, toSettingsDto, toTableTypeDto } from './repository';
import {
  createSettingsInputSchema, overrideInputSchema, settingsDtoSchema, settingsInputSchema,
  tableTypeDtoSchema, tableTypeInputSchema, updateTableTypeInputSchema, weeklyInputSchema,
} from './types';
import type { z } from 'zod';

const repository = new DiningReservationRepository();
const permission = 'dining-reservation:manage';

export const createVenueCommand = defineCommand({
  name: 'dining.reservation.createVenue', input: createSettingsInputSchema, output: settingsDtoSchema,
  permission, idempotency: 'required',
  audit: { action: 'dining.venue.created', resourceType: 'dining_venue',
    resourceId: (_input, output) => output.id, redact: () => ({ result: 'applied' }) },
});

export const updateVenueCommand = defineCommand({
  name: 'dining.reservation.updateVenue', input: settingsInputSchema, output: settingsDtoSchema,
  permission, idempotency: 'required',
  audit: { action: 'dining.venue.updated', resourceType: 'dining_venue',
    resourceId: () => 'singleton', redact: () => ({ result: 'applied' }) },
});

export const createTableTypeCommand = defineCommand({
  name: 'dining.reservation.createTableType', input: tableTypeInputSchema, output: tableTypeDtoSchema,
  permission, idempotency: 'required',
  audit: { action: 'dining.table-type.created', resourceType: 'dining_table_type',
    resourceId: (_input, output) => output.id, redact: () => ({ result: 'applied' }) },
});

export const updateTableTypeCommand = defineCommand({
  name: 'dining.reservation.updateTableType', input: updateTableTypeInputSchema, output: tableTypeDtoSchema,
  permission, idempotency: 'required',
  audit: { action: 'dining.table-type.updated', resourceType: 'dining_table_type',
    resourceId: input => input.tableTypeId, redact: () => ({ result: 'applied' }) },
});

export const setWeeklyStartsCommand = defineCommand({
  name: 'dining.reservation.setWeeklyStarts', input: weeklyInputSchema, output: weeklyInputSchema,
  permission, idempotency: 'required',
  audit: { action: 'dining.schedule.weekly-set', resourceType: 'dining_schedule',
    resourceId: input => `weekday:${input.weekday}`, redact: () => ({ result: 'applied' }) },
});

export const setDateOverrideCommand = defineCommand({
  name: 'dining.reservation.setDateOverride', input: overrideInputSchema, output: overrideInputSchema,
  permission, idempotency: 'required',
  audit: { action: 'dining.schedule.override-set', resourceType: 'dining_schedule',
    resourceId: input => input.date, redact: () => ({ result: 'applied' }) },
});

export async function createVenueHandler(input: z.infer<typeof createSettingsInputSchema>, context: CommandContext) {
  const values = { occupancyMinutes: 90, minAdvanceMinutes: 60, maxAdvanceDays: 30, ...input };
  if (values.minAdvanceMinutes > values.maxAdvanceDays * 1440) {
    throw PlatformError.validation('Maximum booking window must be at least minimum lead time');
  }
  const [row] = await context.tx.insert(diningVenues).values({
    id: randomUUID(), singletonSlot: 1, ...values, createdAt: context.now, updatedAt: context.now,
  }).onConflictDoNothing({ target: diningVenues.singletonSlot }).returning();
  if (!row) throw PlatformError.conflict('This Dining release already has a venue');
  return toSettingsDto(row);
}

export async function updateVenueHandler(input: z.infer<typeof settingsInputSchema>, context: CommandContext) {
  const venue = await repository.lockSettings(context.tx);
  if (!venue) throw PlatformError.notFound('Dining venue', 'singleton');
  if (venue.timezone !== input.timezone) {
    const [request] = await context.tx.select({ id: diningRequestSnapshots.id }).from(diningRequestSnapshots).limit(1);
    if (request) throw PlatformError.conflict('Dining timezone is locked after the first request');
  }
  const [row] = await context.tx.update(diningVenues).set({ ...input, updatedAt: context.now })
    .where(eq(diningVenues.id, venue.id)).returning();
  return toSettingsDto(row!);
}

export async function createTableTypeHandler(input: z.infer<typeof tableTypeInputSchema>, context: CommandContext) {
  const venue = await repository.lockSettings(context.tx);
  if (!venue) throw PlatformError.conflict('Configure the Dining venue before its table types');
  const [existing] = await context.tx.select({ id: diningTableTypes.id }).from(diningTableTypes)
    .where(eq(diningTableTypes.capacity, input.capacity)).limit(1);
  if (existing) throw PlatformError.conflict('A Dining table type already has this seat capacity');
  const [row] = await context.tx.insert(diningTableTypes).values({
    id: randomUUID(), venueId: venue.id, ...input, active: 1, createdAt: context.now, updatedAt: context.now,
  }).returning();
  return toTableTypeDto(row!);
}

export async function updateTableTypeHandler(input: z.infer<typeof updateTableTypeInputSchema>, context: CommandContext) {
  const venue = await repository.lockSettings(context.tx);
  if (!venue) throw PlatformError.notFound('Dining venue', 'singleton');
  const [current] = await context.tx.select().from(diningTableTypes)
    .where(eq(diningTableTypes.id, input.tableTypeId)).limit(1);
  if (!current) throw PlatformError.notFound('Dining table type', input.tableTypeId);
  const [duplicate] = await context.tx.select({ id: diningTableTypes.id }).from(diningTableTypes)
    .where(eq(diningTableTypes.capacity, input.capacity)).limit(1);
  if (duplicate && duplicate.id !== current.id) throw PlatformError.conflict('A Dining table type already has this seat capacity');
  if (!input.active && input.count !== 0) throw PlatformError.validation('Disabled table types must have zero tables');
  await repository.assertTableTypeEditSafe(context.tx, current.id, input.capacity, input.count,
    new Date(Math.max(context.now.getTime(), Date.now())));
  const [row] = await context.tx.update(diningTableTypes).set({
    capacity: input.capacity, count: input.count, active: input.active ? 1 : 0, updatedAt: context.now,
  }).where(eq(diningTableTypes.id, input.tableTypeId)).returning();
  return toTableTypeDto(row!);
}

export async function setWeeklyStartsHandler(input: z.infer<typeof weeklyInputSchema>, context: CommandContext) {
  const venue = await repository.lockSettings(context.tx);
  if (!venue) throw PlatformError.conflict('Configure the Dining venue before its schedule');
  await context.tx.insert(diningWeeklyStarts).values({ venueId: venue.id, ...input })
    .onConflictDoUpdate({ target: diningWeeklyStarts.weekday, set: { startTimes: input.startTimes } });
  return input;
}

export async function setDateOverrideHandler(input: z.infer<typeof overrideInputSchema>, context: CommandContext) {
  const venue = await repository.lockSettings(context.tx);
  if (!venue) throw PlatformError.conflict('Configure the Dining venue before its schedule');
  await context.tx.insert(diningDateOverrides).values({ venueId: venue.id, date: input.date, startTimes: input.startTimes })
    .onConflictDoUpdate({ target: diningDateOverrides.date, set: { startTimes: input.startTimes } });
  return input;
}
