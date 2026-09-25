import { z } from 'zod';
import { baseConfigSchema, type ReleaseConfigDefinition } from '@storeweave/config';
import { resolveConfigProjection, type ConfigProjectionFactory } from '@storeweave/release/config';
import { BOOKING_TARGET_KEYS, bookingFactoryList, bookingReleaseDefinition, requireBookingFactory, validateBookingReleaseDefinition, type BookingFactoryInput } from './definition';

export const bookingConfigSchema = baseConfigSchema.extend({
  store: baseConfigSchema.shape.store.extend({ currency: z.string().length(3).default('TWD') }),
  theme: baseConfigSchema.shape.theme.removeDefault().extend({ id: z.literal('booking-default').default('booking-default') }).default({}),
  booking: z.object({
    maxRoomsPerRequest: z.number().int().min(1).max(20).default(5),
    reservationPiiRetentionDays: z.number().int().safe().min(1),
    operatorAlertEmail: z.string().trim().email().max(320),
  }).strict(),
  extensions: baseConfigSchema.shape.extensions.removeDefault().superRefine((entries, context) => {
    if (entries.length !== 1 || entries[0]?.id !== 'mock-payment' || !entries[0].enabled) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Booking requires one enabled refund-qualified payment Extension "mock-payment"' });
    }
  }),
  logging: baseConfigSchema.shape.logging.removeDefault().extend({ file: z.string().default('/var/log/booking/booking.log') }).default({}),
  paths: baseConfigSchema.shape.paths.removeDefault().extend({
    dataDir: z.string().default('/var/lib/booking'), backupDir: z.string().default('/var/lib/booking/backups'),
  }).default({}),
  secrets: baseConfigSchema.shape.secrets.removeDefault().extend({ file: z.string().default('/etc/booking/booking.env') }).default({}),
}).strict();

export type BookingConfig = z.infer<typeof bookingConfigSchema>;
export const bookingConfigDefinition: ReleaseConfigDefinition<BookingConfig> = {
  schema: bookingConfigSchema,
  envNames: ['STOREWEAVE_CONFIG', 'BOOKING_CONFIG'],
  defaultPaths: ['/etc/booking/booking.yaml', './booking.yaml'],
  defaultSecretFile: bookingConfigSchema.shape.secrets.parse({}).file,
};

export interface BookingConfigProjection { readonly definition: typeof bookingConfigDefinition; readonly defaultFilename: 'booking.yaml' }
export const bookingConfigProjectionFactory: ConfigProjectionFactory<BookingConfigProjection> & { readonly source: string } = {
  target: 'config', key: BOOKING_TARGET_KEYS.config, source: 'packages/releases/booking/src/config.ts',
  resolve: () => ({ definition: bookingConfigDefinition, defaultFilename: 'booking.yaml' }),
};
export function resolveBookingConfigProjection(): BookingConfigProjection;
export function resolveBookingConfigProjection<Contribution>(definition: unknown, factory: BookingFactoryInput<ConfigProjectionFactory<Contribution>>): Contribution;
export function resolveBookingConfigProjection<Contribution>(definition: unknown = bookingReleaseDefinition, factory: BookingFactoryInput<ConfigProjectionFactory<Contribution>> = bookingConfigProjectionFactory as unknown as ConfigProjectionFactory<Contribution>): Contribution {
  return resolveConfigProjection(validateBookingReleaseDefinition(definition), requireBookingFactory('config', bookingFactoryList(factory)));
}
