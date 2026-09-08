import packageJson from '../package.json';
import { z } from 'zod';
import { defineCommand, defineQuery, PlatformError, type CommandContext, type QueryContext } from '@storeweave/contracts';
import type { JobQueue } from '@storeweave/jobs';
import type { EventBus } from '@storeweave/event-bus';
import { asSubscriberSnapshot, type OutboxStore } from '@storeweave/outbox';
import { defineModule, type PlatformModule } from './module';
import { EVENT_DELIVERY_JOB } from './event-delivery';
import { repairAndRedriveOutbox } from './outbox-recovery';
import type { RecurringScheduler } from './recurring';

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

export const quarantinedJobDto = z.object({
  id: z.string(),
  type: z.string(),
  payloadVersion: z.number(),
  occurrenceId: z.string(),
  reason: z.string(),
  quarantinedAt: z.string(),
});

export const listQuarantinedJobsQuery = defineQuery({
  name: 'platform.jobs.listQuarantinedJobs',
  summary: '列出因未知型別或無效 payload 而未執行的背景工作',
  input: listDeadJobsInput,
  output: z.object({ items: z.array(quarantinedJobDto), total: z.number() }),
  permission: 'jobs:read',
});

export const redriveQuarantinedJobInput = z.object({ jobId: z.string().uuid() }).strict();
export const redriveQuarantinedJobCommand = defineCommand({
  name: 'platform.jobs.redriveQuarantinedJob',
  summary: '在修正 job descriptor 或 payload 相容性後重新投遞 quarantined 工作',
  input: redriveQuarantinedJobInput,
  output: retryJobOutput,
  permission: 'jobs:write',
  idempotency: 'required',
  audit: { action: 'jobs.quarantine.redriven', resourceType: 'job', resourceId: (i) => i.jobId },
});

export const outboxFailureDto = z.object({
  id: z.string(),
  eventName: z.string(),
  eventVersion: z.number(),
  status: z.enum(['dead', 'quarantined', 'relayed']),
  attempts: z.number(),
  subscriberIds: z.array(z.string()).nullable(),
  // `null` alone cannot tell an operator whether the legacy set is merely unknown (repairable
  // with evidence) or corrupt (no repair path at all), so the distinction is explicit.
  snapshotState: z.enum(['frozen', 'legacy_unknown', 'invalid']),
  reason: z.string().nullable(),
  occurredAt: z.string(),
});

export const listOutboxFailuresQuery = defineQuery({
  name: 'platform.outbox.listFailures',
  summary: '列出需要人工處理的 outbox relay failure、quarantine 或 quarantined delivery',
  input: listDeadJobsInput,
  output: z.object({ items: z.array(outboxFailureDto), total: z.number() }),
  permission: 'jobs:read',
});

export const redriveOutboxFailureInput = z.object({
  outboxId: z.string().uuid(),
  subscriberIds: z.array(z.string().trim().min(1)).max(1_000),
  evidence: z.string().trim().min(1).max(2_000),
  // Repairing an unknown legacy snapshot to the empty set makes the event terminal with no
  // subscriber ever running, and the default value must never be able to cause that silently.
  acknowledgeEmptyFanout: z.boolean().default(false),
}).strict();
export const redriveOutboxFailureCommand = defineCommand({
  name: 'platform.outbox.redriveFailure',
  summary: '驗證 frozen subscriber snapshot 後重送 outbox failure，並留下 operator evidence',
  input: redriveOutboxFailureInput,
  output: z.object({ outboxId: z.string(), status: z.enum(['pending', 'relayed']) }),
  permission: 'jobs:write',
  idempotency: 'required',
  audit: { action: 'outbox.failure.redriven', resourceType: 'outbox', resourceId: (i) => i.outboxId },
});

export interface OpsModuleDependencies {
  readonly events: EventBus;
  readonly outbox: OutboxStore;
  /**
   * 排程器要等資料庫連線建立後才存在，而模組組裝發生在那之前（Release 選取需要模組清單）。
   * 用 thunk 取代直接注入，讓這個順序留在 runtime 裡，而不是逼 ops 模組提早知道連線。
   */
  readonly scheduler: () => RecurringScheduler;
}

export const scheduleDto = z.object({
  type: z.string(),
  kind: z.enum(['interval', 'cron']),
  expression: z.string(),
  timezone: z.string().nullable(),
  catchUp: z.number(),
  overlap: z.enum(['queue', 'skip']),
  paused: z.boolean(),
  pausedAt: z.string().nullable(),
  lastOccurrenceAt: z.string().nullable(),
  lastEnqueuedAt: z.string().nullable(),
  skippedCatchup: z.number(),
  skippedPaused: z.number(),
  skippedOverlap: z.number(),
  consecutiveOverlapSkips: z.number(),
  nextOccurrenceAt: z.string().nullable(),
});

export const listSchedulesQuery = defineQuery({
  name: 'platform.jobs.listSchedules',
  summary: '列出這個 Release 宣告的週期性工作及其排程狀態',
  input: z.object({}).strict(),
  output: z.object({ items: z.array(scheduleDto) }),
  permission: 'jobs:read',
});

export const scheduleTypeInput = z.object({ type: z.string().min(1) }).strict();
export const scheduleStateOutput = z.object({ type: z.string(), paused: z.boolean() });

export const pauseScheduleCommand = defineCommand({
  name: 'platform.jobs.pauseSchedule',
  summary: '暫停一個週期性工作；暫停期間的 occurrence 是跳過而不是累積',
  input: scheduleTypeInput,
  output: scheduleStateOutput,
  permission: 'jobs:write',
  idempotency: 'required',
  audit: { action: 'jobs.schedule.paused', resourceType: 'schedule', resourceId: (i) => i.type },
});

export const resumeScheduleCommand = defineCommand({
  name: 'platform.jobs.resumeSchedule',
  summary: '恢復一個被暫停的週期性工作，從當下這一次繼續',
  input: scheduleTypeInput,
  output: scheduleStateOutput,
  permission: 'jobs:write',
  idempotency: 'required',
  audit: { action: 'jobs.schedule.resumed', resourceType: 'schedule', resourceId: (i) => i.type },
});

export function createOpsModule(jobs: JobQueue, dependencies: OpsModuleDependencies): PlatformModule {
  return defineModule({
    name: OPS_MODULE_NAME,
    version: packageJson.version,
    baseVersionRange: '^1.0.0',
    dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }] },
    permissions: [
      { key: 'jobs:read', description: '檢視背景工作、死信與 quarantine', owner: OPS_MODULE_NAME },
      { key: 'jobs:write', description: '重送死信與經審核的 quarantine 工作', owner: OPS_MODULE_NAME },
    ],
    commands: [
      {
        descriptor: retryJobCommand,
        handler: async (input: z.infer<typeof retryJobInput>, ctx: CommandContext) => {
          await jobs.retryDead(ctx.tx, input.jobId);
          return { jobId: input.jobId, status: 'pending' as const };
        },
      },
      {
        descriptor: redriveQuarantinedJobCommand,
        handler: async (input: z.infer<typeof redriveQuarantinedJobInput>, ctx: CommandContext) => {
          const job = await jobs.getMetadata(ctx.tx, input.jobId);
          if (job?.type === EVENT_DELIVERY_JOB) {
            throw PlatformError.conflict('Event delivery quarantine must be redriven through platform.outbox.redriveFailure');
          }
          await jobs.redriveQuarantined(ctx.tx, input.jobId);
          return { jobId: input.jobId, status: 'pending' as const };
        },
      },
      {
        descriptor: pauseScheduleCommand,
        handler: async (input: z.infer<typeof scheduleTypeInput>, ctx: CommandContext) => {
          await dependencies.scheduler().setPaused(ctx.tx, input.type, true);
          return { type: input.type, paused: true };
        },
      },
      {
        descriptor: resumeScheduleCommand,
        handler: async (input: z.infer<typeof scheduleTypeInput>, ctx: CommandContext) => {
          await dependencies.scheduler().setPaused(ctx.tx, input.type, false);
          return { type: input.type, paused: false };
        },
      },
      {
        descriptor: redriveOutboxFailureCommand,
        handler: async (input: z.infer<typeof redriveOutboxFailureInput>, ctx: CommandContext) => {
          const { events, outbox } = dependencies;
          const result = await repairAndRedriveOutbox(ctx.tx, { events, jobs, outbox }, input);
          return { outboxId: input.outboxId, status: result.status };
        },
      },
    ],
    queries: [
      {
        descriptor: listSchedulesQuery,
        handler: async (_input: unknown, ctx: QueryContext) => {
          const items = await dependencies.scheduler().list(ctx.db);
          return {
            items: items.map((item) => ({
              ...item,
              pausedAt: item.pausedAt?.toISOString() ?? null,
              lastOccurrenceAt: item.lastOccurrenceAt?.toISOString() ?? null,
              lastEnqueuedAt: item.lastEnqueuedAt?.toISOString() ?? null,
              nextOccurrenceAt: item.nextOccurrenceAt?.toISOString() ?? null,
            })),
          };
        },
      },
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
      {
        descriptor: listQuarantinedJobsQuery,
        handler: async (input: z.infer<typeof listDeadJobsInput>, ctx: QueryContext) => {
          const { items, total } = await jobs.listQuarantined(ctx.db, input);
          return {
            total,
            items: items.map((row) => ({
              id: row.id,
              type: row.type,
              payloadVersion: Number(row.payload_version),
              occurrenceId: row.occurrence_id,
              reason: row.reason,
              quarantinedAt: new Date(row.created_at).toISOString(),
            })),
          };
        },
      },
      {
        descriptor: listOutboxFailuresQuery,
        handler: async (input: z.infer<typeof listDeadJobsInput>, ctx: QueryContext) => {
          const { outbox } = dependencies;
          const { items, total } = await outbox.listFailures(ctx.db, input);
          return {
            total,
            items: items.map((row) => ({
              id: row.id,
              eventName: row.event_name,
              eventVersion: Number(row.event_version),
              status: row.status,
              attempts: Number(row.attempts),
              subscriberIds: asSubscriberSnapshot(row.subscriber_ids) ?? null,
              snapshotState: asSubscriberSnapshot(row.subscriber_ids) ? 'frozen'
                : row.subscriber_ids === null ? 'legacy_unknown' : 'invalid',
              reason: row.reason,
              occurredAt: new Date(row.occurred_at).toISOString(),
            })),
          };
        },
      },
    ],
  });
}
