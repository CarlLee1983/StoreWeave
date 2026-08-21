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
});

export const jobs = pgTable('platform_jobs', {
  id: uuid('id').primaryKey(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  dedupeKey: text('dedupe_key'),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lockedBy: text('locked_by'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
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
