import { z } from 'zod';
import { defineQuery, PlatformError, type QueryContext } from '@storeweave/contracts';
import { DiningReservationRepository, toSettingsDto, toTableTypeDto } from './repository';
import { isWithinBookingWindow, offeredStartTimes, resolveLocalStart } from './schedule';
import { localDateSchema, overrideDtoSchema, settingsDtoSchema, tableTypeDtoSchema, weeklyDtoSchema } from './types';

const repository = new DiningReservationRepository();
const empty = z.object({}).strict();
const permission = 'dining-reservation:read';

export const getVenueQuery = defineQuery({ name: 'dining.reservation.getVenue', input: empty,
  output: settingsDtoSchema.nullable(), permission });
export const listTableTypesQuery = defineQuery({ name: 'dining.reservation.listTableTypes', input: empty,
  output: z.array(tableTypeDtoSchema), permission });
export const listWeeklyStartsQuery = defineQuery({ name: 'dining.reservation.listWeeklyStarts', input: empty,
  output: z.array(weeklyDtoSchema), permission });
export const listDateOverridesQuery = defineQuery({ name: 'dining.reservation.listDateOverrides', input: empty,
  output: z.array(overrideDtoSchema), permission });
export const getOpenStartsQuery = defineQuery({ name: 'dining.reservation.getOpenStarts',
  input: z.object({ date: localDateSchema }).strict(), output: z.array(z.object({
    time: z.string(), startAt: z.date(), endAt: z.date(),
  }).strict()), permission });

export async function getVenueHandler(_input: unknown, context: QueryContext) {
  const row = await repository.getSettings(context.db);
  return row ? toSettingsDto(row) : null;
}
export async function listTableTypesHandler(_input: unknown, context: QueryContext) {
  return (await repository.listTableTypes(context.db)).map(toTableTypeDto);
}
export async function listWeeklyStartsHandler(_input: unknown, context: QueryContext) {
  return repository.listWeekly(context.db);
}
export async function listDateOverridesHandler(_input: unknown, context: QueryContext) {
  return repository.listOverrides(context.db);
}
export async function getOpenStartsHandler(input: { date: string }, context: QueryContext) {
  const venue = await repository.getSettings(context.db);
  if (!venue) throw PlatformError.notFound('Dining venue', 'singleton');
  const times = offeredStartTimes(input.date, await repository.listWeekly(context.db), await repository.listOverrides(context.db));
  return times.flatMap(time => {
    const startAt = resolveLocalStart(input.date, time, venue.timezone);
    if (!startAt || !isWithinBookingWindow(startAt, context.now, {
      minAdvanceMinutes: venue.minAdvanceMinutes, maxAdvanceDays: venue.maxAdvanceDays,
    })) return [];
    return [{ time, startAt, endAt: new Date(startAt.getTime() + venue.occupancyMinutes * 60_000) }];
  });
}
