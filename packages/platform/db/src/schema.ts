import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const outbox = pgTable('platform_outbox', {
  id: uuid('id').primaryKey(),
  eventName: text('event_name').notNull(),
  eventVersion: integer('event_version').notNull(),
  payload: jsonb('payload').notNull(),
  actorId: text('actor_id').notNull(),
  correlationId: text('correlation_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  relayedAt: timestamp('relayed_at', { withTimezone: true }),
  /** NULL is intentionally reserved for pre-B04 rows whose subscriber set is unknown. */
  subscriberIds: jsonb('subscriber_ids'),
});

/** An undecodable outbox row is evidence, never a silently dropped event. */
export const outboxQuarantine = pgTable('platform_outbox_quarantine', {
  id: uuid('id').defaultRandom().primaryKey(),
  outboxId: uuid('outbox_id').notNull(),
  eventName: text('event_name').notNull(),
  eventVersion: integer('event_version').notNull(),
  payload: jsonb('payload').notNull(),
  subscriberIds: jsonb('subscriber_ids'),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Operator repair and redrive provenance stays append-only beside the evidence. */
export const outboxQuarantineAudit = pgTable('platform_outbox_quarantine_audit', {
  id: uuid('id').defaultRandom().primaryKey(),
  outboxId: uuid('outbox_id').notNull(),
  action: text('action').notNull(),
  subscriberIds: jsonb('subscriber_ids'),
  evidence: text('evidence').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jobs = pgTable('platform_jobs', {
  id: uuid('id').primaryKey(),
  occurrenceId: uuid('occurrence_id').notNull(),
  claimToken: uuid('claim_token'),
  type: text('type').notNull(),
  payload: jsonb('payload'),
  payloadVersion: integer('payload_version').notNull().default(1),
  dedupeKey: text('dedupe_key'),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lockedBy: text('locked_by'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  deferredType: text('deferred_type'),
  deferredPayload: jsonb('deferred_payload'),
  deferredPayloadVersion: integer('deferred_payload_version'),
  deferredRunAt: timestamp('deferred_run_at', { withTimezone: true }),
  deferredMaxAttempts: integer('deferred_max_attempts'),
  deferredAt: timestamp('deferred_at', { withTimezone: true }),
  cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  retainUntil: timestamp('retain_until', { withTimezone: true }),
  dedupeUntil: timestamp('dedupe_until', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

/** Payload failures are evidence, not dead-letter retries: their handler never ran. */
export const jobQuarantine = pgTable('platform_job_quarantine', {
  id: uuid('id').defaultRandom().primaryKey(),
  jobId: uuid('job_id').notNull(),
  occurrenceId: uuid('occurrence_id').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  payloadVersion: integer('payload_version').notNull(),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const idempotency = pgTable('platform_idempotency', {
  commandName: text('command_name').notNull(),
  key: text('key').notNull(),
  requestHash: text('request_hash').notNull(),
  status: text('status').notNull(),
  response: jsonb('response'),
  actorId: text('actor_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const auditLog = pgTable('platform_audit_log', {
  id: uuid('id').primaryKey(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  actorId: text('actor_id').notNull(),
  actorType: text('actor_type').notNull(),
  extensionId: text('extension_id'),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id'),
  correlationId: text('correlation_id').notNull(),
  payload: jsonb('payload'),
});

export const extensionState = pgTable('platform_extension_state', {
  extensionId: text('extension_id').notNull(),
  key: text('key').notNull(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const extensionRegistry = pgTable('platform_extension_registry', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  platformVersion: text('platform_version').notNull(),
  permissions: jsonb('permissions').notNull(),
  installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
