import packageJson from '../package.json';
import { z } from 'zod';
import { defineCommand, defineQuery, type CommandContext, type QueryContext } from '@storeweave/contracts';
import type { JobQueue } from '@storeweave/jobs';
import { defineModule, type PlatformModule } from './module';

/**
 * 平台自身的維運介面。這裡只碰 platform_* 資料表，對領域一無所知，
 * 因此不論這個 Release 編進哪一組產品模組，它都在。
 */
export const OPS_MODULE_NAME = 'platform-ops';

export const deadJobDto = z.object({
  id: z.string(),
  type: z.string(),
  attempts: z.number(),
  maxAttempts: z.number(),
  dedupeKey: z.string().nullable(),
  lastError: z.string().nullable(),
  failedAt: z.string(),
});

export const listDeadJobsInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
}).strict();

export const listDeadJobsOutput = z.object({
  items: z.array(deadJobDto),
  total: z.number(),
});

export const listDeadJobsQuery = defineQuery({
  name: 'platform.jobs.listDeadJobs',
  summary: '列出進入死信佇列、需要人工介入的背景工作',
  input: listDeadJobsInput,
  output: listDeadJobsOutput,
  permission: 'jobs:read',
});

export const retryJobInput = z.object({ jobId: z.string().uuid() }).strict();
export const retryJobOutput = z.object({ jobId: z.string(), status: z.literal('pending') });

export const retryJobCommand = defineCommand({
  name: 'platform.jobs.retryJob',
  summary: '把死信佇列裡的背景工作放回佇列重跑',
  input: retryJobInput,
  output: retryJobOutput,
  permission: 'jobs:write',
  idempotency: 'required',
  audit: { action: 'jobs.retried', resourceType: 'job', resourceId: (i) => i.jobId },
});

export function createOpsModule(jobs: JobQueue): PlatformModule {
  return defineModule({
    name: OPS_MODULE_NAME,
    version: packageJson.version,
    baseVersionRange: '^1.0.0',
    dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }] },
    permissions: [
      { key: 'jobs:read', description: '檢視背景工作與死信佇列', owner: OPS_MODULE_NAME },
      { key: 'jobs:write', description: '重送死信佇列裡的背景工作', owner: OPS_MODULE_NAME },
    ],
    commands: [
      {
        descriptor: retryJobCommand,
        handler: async (input: z.infer<typeof retryJobInput>, ctx: CommandContext) => {
          await jobs.retryDead(ctx.tx, input.jobId);
          return { jobId: input.jobId, status: 'pending' as const };
        },
      },
    ],
    queries: [
      {
        descriptor: listDeadJobsQuery,
        handler: async (input: z.infer<typeof listDeadJobsInput>, ctx: QueryContext) => {
          const { items, total } = await jobs.listDead(ctx.db, input);
          return {
            total,
            items: items.map((row) => ({
              id: row.id,
              type: row.type,
              attempts: Number(row.attempts),
              maxAttempts: Number(row.max_attempts),
              dedupeKey: row.dedupe_key,
              lastError: row.last_error,
              failedAt: new Date(row.updated_at).toISOString(),
            })),
          };
        },
      },
    ],
  });
}
