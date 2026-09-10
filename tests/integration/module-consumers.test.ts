import { BASE_ROLES } from '@storeweave/authorization';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  defineCommand, defineEvent, defineQuery, noopLogger, PlatformError,
  type DomainEvent, type Tx,
} from '@storeweave/contracts';
import {
  bindModuleCapability, createRuntime, defineModule,
  type BoundModuleCapability, type Runtime,
} from '@storeweave/kernel';
import { ADMIN_ACTOR, actorWith, createTestDatabase, testConfig, testSecretProvider } from './helpers';

const baseDependency = { name: 'platform', versionRange: '^0.1.0' };
const enrolled = defineEvent({ name: 'activities.enrollment.created.v1', payload: z.object({ id: z.string().uuid(), eventId: z.string().uuid() }) });
const confirmCapacity = defineCommand({
  name: 'activities.capacity.confirm', input: z.object({ eventId: z.string().uuid() }).strict(),
  output: z.object({ confirmed: z.literal(true) }), permission: 'capacity:write', idempotency: 'required',
});
const enroll = defineCommand({
  name: 'activities.enrollment.create',
  input: z.object({ eventId: z.string().uuid(), email: z.string().email() }).strict(),
  output: z.object({ id: z.string().uuid() }), permission: 'enrollment:write', idempotency: 'required',
});
const listEnrollments = defineQuery({
  name: 'activities.enrollment.list', input: z.object({ eventId: z.string().uuid() }).strict(),
  output: z.object({ emails: z.array(z.string().email()) }), permission: 'enrollment:read',
});

const capacityService = {
  async reserve(tx: Tx, eventId: string): Promise<void> {
    const result = await tx.execute(sql`UPDATE activity_capacity SET available = available - 1
      WHERE id = ${eventId} AND available > 0 RETURNING id`);
    if (result.rows.length !== 1) throw PlatformError.conflict('This activity is full');
  },
};
const capacityModule = defineModule({
  name: 'activity-capacity', version: '0.1.0', baseVersionRange: '^1.0.0',
  dependencies: { required: [baseDependency] },
  capabilities: { provides: ['activities.capacity.reserve'] },
  data: { owns: ['activity_capacity'] },
  migrations: { module: 'activity-capacity', migrations: [{ id: '0001_capacity', phase: 'expand', up:
    'CREATE TABLE activity_capacity (id uuid PRIMARY KEY, available integer NOT NULL CHECK (available >= 0), confirmations integer NOT NULL DEFAULT 0)',
  }] },
  permissions: [{ key: 'capacity:write', description: 'Confirm enrollment capacity', owner: 'activity-capacity' }],
  commands: [{ descriptor: confirmCapacity, handler: async (input, ctx) => {
    await ctx.tx.execute(sql`UPDATE activity_capacity SET confirmations = confirmations + 1 WHERE id = ${input.eventId}`);
    return { confirmed: true };
  } }],
});

function enrollmentModule(capacity: BoundModuleCapability<{ reserve(tx: Tx, eventId: string): Promise<void> }>) {
  return defineModule({
    name: 'activity-enrollment', version: '0.1.0', baseVersionRange: '^1.0.0',
    dependencies: { required: [baseDependency] },
    capabilities: {
      required: [{ from: 'activity-capacity', capability: 'activities.capacity.reserve', versionRange: '^0.1.0' }],
      bound: [capacity],
    },
    data: { owns: ['activity_enrollments'] },
    migrations: { module: 'activity-enrollment', migrations: [{ id: '0001_enrollments', phase: 'expand', up:
      'CREATE TABLE activity_enrollments (id uuid PRIMARY KEY, event_id uuid NOT NULL, email text NOT NULL)',
    }] },
    events: [enrolled],
    permissions: [
      { key: 'enrollment:write', description: 'Enroll in an activity', owner: 'activity-enrollment' },
      { key: 'enrollment:read', description: 'List activity enrollments', owner: 'activity-enrollment' },
    ],
    commands: [{ descriptor: enroll, handler: async (input, ctx) => {
      const id = randomUUID();
      await ctx.tx.execute(sql`INSERT INTO activity_enrollments (id, event_id, email) VALUES (${id}, ${input.eventId}, ${input.email})`);
      await ctx.publish({ name: enrolled.name, payload: { id, eventId: input.eventId } });
      // Reserve last so failure proves the owner's row and Outbox write roll back together.
      await capacity.value.reserve(ctx.tx, input.eventId);
      return { id };
    } }],
    queries: [{ descriptor: listEnrollments, handler: async (input, ctx) => {
      const result = await ctx.db.execute<{ email: string }>(sql`SELECT email FROM activity_enrollments WHERE event_id = ${input.eventId} ORDER BY email`);
      return { emails: result.rows.map((row) => row.email) };
    } }],
    subscribers: [{
      eventName: enrolled.name,
      commands: [{ from: 'activity-capacity', name: confirmCapacity.name, version: confirmCapacity.version }],
      handler: async (event, ctx) => {
        await ctx.executeCommand!(confirmCapacity.name, { eventId: event.payload.eventId }, `confirmed:${event.id}`);
      },
    }],
  });
}

let runtime: Runtime;
beforeAll(async () => {
  const url = await createTestDatabase();
  runtime = await createRuntime({
    release: { id: 'test', version: '1.0.0', buildManifestChecksum: `sha256:${'0'.repeat(64)}` },
    roles: BASE_ROLES,
    config: testConfig(url, { extensions: {} }),
    secrets: testSecretProvider({ SW_SIGNING_KEY_TEST: Buffer.alloc(32, 3).toString('base64url') }), logger: noopLogger,
    availableExtensions: {},
    modules: [enrollmentModule(bindModuleCapability('activity-capacity', 'activities.capacity.reserve', capacityService)), capacityModule,
      defineModule({
        name: 'ungranted-subscriber', version: '0.1.0', baseVersionRange: '^1.0.0',
        dependencies: { required: [baseDependency] },
        subscribers: [{ eventName: enrolled.name, handler: async (event, ctx) => {
          await ctx.executeCommand!(confirmCapacity.name, { eventId: event.payload.eventId }, event.id);
        } }],
      }),
    ],
  });
  await runtime.migrate();
}, 300_000);
afterAll(async () => { await runtime?.close(); });

async function activity(available: number) {
  const id = randomUUID();
  await runtime.database.db.execute(sql`INSERT INTO activity_capacity (id, available) VALUES (${id}, ${available})`);
  return id;
}
const enrollAt = (eventId: string, email = 'attendee@example.test') => runtime.commands.execute<{ id: string }>(
  enroll.name, { eventId, email }, { actor: actorWith(['enrollment:write']), idempotencyKey: randomUUID() },
);

describe('noncommerce modules use the production module graph and transaction boundary', () => {
  it('migrates only platform and selected activity tables, then executes a command and query', async () => {
    const tables = await runtime.database.db.execute<{ tablename: string }>(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    expect(tables.rows.every(({ tablename }) => tablename.startsWith('platform_') || tablename.startsWith('activity_'))).toBe(true);
    expect(runtime.modules[0].name).toBe('platform');
    const eventId = await activity(1);
    await enrollAt(eventId);
    expect(await runtime.queries.execute(listEnrollments.name, { eventId }, { actor: actorWith(['enrollment:read']) }))
      .toEqual({ emails: ['attendee@example.test'] });
    const capacity = await runtime.database.db.execute(sql`SELECT available FROM activity_capacity WHERE id = ${eventId}`);
    expect(capacity.rows[0].available).toBe(0);
  });

  it('rolls back the enrollment and Outbox event when the injected capacity operation rejects', async () => {
    const eventId = await activity(0);
    await expect(enrollAt(eventId)).rejects.toMatchObject({ code: 'CONFLICT' });
    const rows = await runtime.database.db.execute(sql`SELECT id FROM activity_enrollments WHERE event_id = ${eventId}`);
    const events = await runtime.database.db.execute(sql`SELECT id FROM platform_outbox WHERE payload->>'eventId' = ${eventId}`);
    expect(rows.rows).toEqual([]);
    expect(events.rows).toEqual([]);
  });

  it('preserves permission checks on both operations', async () => {
    const eventId = await activity(1);
    await expect(runtime.commands.execute(enroll.name, { eventId, email: 'reader@example.test' },
      { actor: actorWith(['enrollment:read']), idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runtime.queries.execute(listEnrollments.name, { eventId },
      { actor: actorWith(['enrollment:write']) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('executes an explicitly granted foreign command and rejects an ungranted subscriber before execution', async () => {
    const eventId = await activity(1);
    const { id } = await enrollAt(eventId);
    const event: DomainEvent = {
      id: randomUUID(), name: enrolled.name, version: 1, occurredAt: new Date(),
      actorId: 'test', correlationId: randomUUID(), payload: { id, eventId },
    };
    const execute = vi.fn((name: string, input: unknown, idempotencyKey: string) =>
      runtime.commands.execute(name, input, { actor: ADMIN_ACTOR, idempotencyKey }));
    const ctx = { logger: noopLogger, correlationId: event.correlationId, executeCommand: execute };
    const subscriptions = runtime.events.subscribersFor(enrolled.name);
    await subscriptions.find((sub) => sub.subscriberId === 'activity-enrollment')!.handler(event, ctx);
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockClear();
    await expect(subscriptions.find((sub) => sub.subscriberId === 'ungranted-subscriber')!.handler(event, ctx))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(execute).not.toHaveBeenCalled();
    const result = await runtime.database.db.execute(sql`SELECT confirmations FROM activity_capacity WHERE id = ${eventId}`);
    expect(result.rows[0].confirmations).toBe(1);
  });
});
