import { z } from 'zod';
import { baseConfigSchema, type ReleaseConfigDefinition } from '@storeweave/config';

const positiveInteger = z.number().int().safe().positive();
const submissionLimit = z.object({
  maxSubmissions: positiveInteger,
  windowSeconds: positiveInteger,
}).strict();

export const diningConfigSchema = baseConfigSchema.extend({
  dining: z.object({
    reservationPiiRetentionDays: positiveInteger,
    publicRequestRateLimits: z.object({
      source: submissionLimit,
      recipient: submissionLimit,
    }).strict(),
  }).strict(),
  logging: baseConfigSchema.shape.logging.removeDefault().extend({ file: z.string().default('/var/log/dining/dining.log') }).default({}),
  paths: baseConfigSchema.shape.paths.removeDefault().extend({
    dataDir: z.string().default('/var/lib/dining'), backupDir: z.string().default('/var/lib/dining/backups'),
  }).default({}),
  secrets: baseConfigSchema.shape.secrets.removeDefault().extend({ file: z.string().default('/etc/dining/dining.env') }).default({}),
}).strict();

export type DiningConfig = z.infer<typeof diningConfigSchema>;

export const diningConfigDefinition: ReleaseConfigDefinition<DiningConfig> = {
  schema: diningConfigSchema,
  envNames: ['STOREWEAVE_CONFIG', 'DINING_CONFIG'],
  defaultPaths: ['/etc/dining/dining.yaml', './dining.yaml'],
  defaultSecretFile: diningConfigSchema.shape.secrets.parse({}).file,
};
