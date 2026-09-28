import { z } from 'zod';

export const timezoneSchema = z.string().min(1).max(100).refine(value => {
  if (!/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
}, 'Expected a valid IANA time zone');
export const localTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !value.startsWith('0000-') && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Expected a calendar date');

const settingsObjectSchema = z.object({
  name: z.string().trim().min(1).max(160),
  timezone: timezoneSchema,
  occupancyMinutes: z.number().int().min(1).max(1440),
  minAdvanceMinutes: z.number().int().min(1).max(525600),
  maxAdvanceDays: z.number().int().min(1).max(365),
}).strict();
export const settingsInputSchema = settingsObjectSchema.refine(value => value.minAdvanceMinutes <= value.maxAdvanceDays * 1440,
  { path: ['maxAdvanceDays'], message: 'Maximum window must be at least minimum lead time' });

export const createSettingsInputSchema = settingsObjectSchema.partial({
  occupancyMinutes: true, minAdvanceMinutes: true, maxAdvanceDays: true,
});

export const settingsDtoSchema = settingsObjectSchema.extend({
  id: z.string().uuid(), createdAt: z.date(), updatedAt: z.date(),
});

export const tableTypeInputSchema = z.object({
  capacity: z.number().int().min(1).max(1000),
  count: z.number().int().min(1).max(10000),
}).strict();
export const updateTableTypeInputSchema = tableTypeInputSchema.extend({
  tableTypeId: z.string().uuid(), active: z.boolean(), count: z.number().int().min(0).max(10000),
}).strict();
export const tableTypeDtoSchema = tableTypeInputSchema.extend({
  id: z.string().uuid(), active: z.boolean(), count: z.number().int().min(0).max(10000),
  createdAt: z.date(), updatedAt: z.date(),
});

const startTimesSchema = z.array(localTimeSchema).max(1440).refine(times => new Set(times).size === times.length,
  'Start times must be unique');
export const weeklyInputSchema = z.object({ weekday: z.number().int().min(0).max(6), startTimes: startTimesSchema }).strict();
export const overrideInputSchema = z.object({ date: localDateSchema, startTimes: startTimesSchema }).strict();
export const weeklyDtoSchema = weeklyInputSchema;
export const overrideDtoSchema = overrideInputSchema;

export type SettingsDto = z.infer<typeof settingsDtoSchema>;
export type TableTypeDto = z.infer<typeof tableTypeDtoSchema>;
export type WeeklyStarts = z.infer<typeof weeklyInputSchema>;
export type DateOverride = z.infer<typeof overrideInputSchema>;
