import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { defineCommand, defineEvent, noopLogger, PlatformError } from '@storeweave/contracts';
import { createRuntime, Worker, type PlatformModule, type Runtime } from '@storeweave/kernel';
import { createTestDatabase } from './helpers';

const EVENT = defineEvent({ name: 'test.outbox.emitted.v1', payload: z.object({ value: z.string() }).strict() });
const EMIT = defineCommand({
  name: 'test.outbox.emit', input: z.object({ value: z.string() }).strict(), output: z.object({ ok: z.literal(true) }),
  permission: 'test:write', idempotency: 'required',
});
const handled: { subscriber: string; key?: string }[] = [];
let runtimeRef: Runtime | undefined;
let alphaFailure: 'none' | 'once' | 'not-found' = 'none';
let alphaCalls = 0;

function module(name: string, subscriber?: (event: unknown, ctx: any) => Promise<void>): PlatformModule {
  return {
    name, version: '1.0.0', baseVersionRange: '^1.0.0',
    ...(name === 'publisher' ? {
      permissions: [{ key: 'test:write', description: 'test', owner: 'publisher' }], events: [EVENT],
      commands: [{ descriptor: EMIT, handler: async (input, ctx) => { await ctx.publish({ name: EVENT.name, payload: input }); return { ok: true as const }; } }],
    } : {}),
    ...(subscriber ? { subscribers: [{ eventName: EVENT.name, handler: subscriber }] } : {}),
  };
}

async function setup() {
  handled.length = 0;
  alphaFailure = 'none';
  alphaCalls = 0;
  const url = await createTestDatabase();
  const instance = await createRuntime({
    release: { id: 'outbox-delivery', version: '1.0.0', buildManifestChecksum: `sha256:${'4'.repeat(64)}` },
    roles: BASE_ROLES,
    config: baseConfigSchema.parse({ version: 1, store: { id: 'outbox-delivery', name: 'Outbox delivery' }, database: { url }, logging: { level: 'error' } }),
    secrets: { get: () => undefined, has: () => false, listNames: () => [] }, logger: noopLogger, availableExtensions: {},
    modules: [
      module('publisher'),
      module('alpha', async (_event, ctx) => {
        alphaCalls += 1;
        handled.push({ subscriber: 'alpha', key: ctx.idempotencyKey });
        if (alphaFailure === 'not-found') throw PlatformError.notFound('business record', 'missing');
        if (alphaFailure === 'once' && alphaCalls === 1) {
          await runtimeRef!.database.db.execute(sql`
            INSERT INTO outbox_delivery_effects (idempotency_key) VALUES (${ctx.idempotencyKey}) ON CONFLICT DO NOTHING
          `);
          throw new Error('crash after effect');
        }
      }),
      module('beta', async (_event, ctx) => { handled.push({ subscriber: 'beta', key: ctx.idempotencyKey }); }),
    ],
  });
  runtimeRef = instance;
  await instance.migrate();
  await instance.database.db.execute(sql`CREATE TABLE outbox_delivery_effects (idempotency_key text PRIMARY KEY)`);
  return { instance, worker: new Worker(instance, { workerId: `outbox-${randomUUID()}`, outboxBatchSize: 8, concurrency: 8 }) };
}

afterEach(async () => { await runtimeRef?.close(); runtimeRef = undefined; });

async function emit(instance: Runtime) {
  await instance.commands.execute(EMIT.name, { value: 'ok' }, { actor: { id: 'test', type: 'service', displayName: 'test', permissions: ['*'] }, idempotencyKey: randomUUID() });
  const row = await instance.database.db.execute<{ id: string }>(sql`SELECT id FROM platform_outbox ORDER BY occurred_at DESC LIMIT 1`);
  return row.rows[0]!.id;
}

/**
 * Every redrive goes through the public command: there is no second entry point that can change
 * outbox state without jobs:write, an idempotency key and an audit row.
 */
async function redrive(instance: Runtime, input: { outboxId: string; subscriberIds: readonly string[]; evidence: string; acknowledgeEmptyFanout?: boolean }) {
  return instance.commands.execute('platform.outbox.redriveFailure', input, {
    actor: { id: 'ops', type: 'service', displayName: 'ops', permissions: ['*'] }, idempotencyKey: randomUUID(),
  });
}

async function makePendingJobsDue(instance: Runtime) {
  await instance.database.db.execute(sql`UPDATE platform_jobs SET run_at = now() - interval '1 second' WHERE status = 'pending'`);
}

describe('B04 outbox fan-out and delivery quarantine', () => {
  it('rolls back an entire event fan-out on its second enqueue failure, then retries exactly once per snapshot subscriber', async () => {
    const { instance, worker } = await setup();
    const id = await emit(instance);
    const original = instance.jobs.enqueue.bind(instance.jobs);
    const enqueue = vi.spyOn(instance.jobs, 'enqueue').mockImplementation(async (tx, input) => {
      if ((input.payload as any).subscriberId === 'beta') throw new Error('second enqueue fails');
      return original(tx, input);
    });
    expect(await worker.relayOutbox()).toEqual({ relayed: 0, enqueued: 0 });
    expect((await instance.database.db.execute(sql`SELECT id FROM platform_jobs WHERE dedupe_key LIKE ${`evt:${id}:%`}`)).rows).toEqual([]);
    await instance.database.db.execute(sql`UPDATE platform_outbox SET available_at = now() - interval '1 second' WHERE id = ${id}`);
    enqueue.mockRestore();
    expect(await worker.relayOutbox()).toEqual({ relayed: 1, enqueued: 2 });
    expect((await instance.database.db.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM platform_jobs WHERE dedupe_key LIKE ${`evt:${id}:%`}`)).rows)
      .toEqual([{ count: '2' }]);
  });

  it('uses a frozen snapshot across concurrent relays; a removed subscriber is quarantined and can be restored with the same event key', async () => {
    const { instance, worker } = await setup();
    const id = await emit(instance);
    const original = instance.events.subscribersFor.bind(instance.events);
    const subscriptions = vi.spyOn(instance.events, 'subscribersFor').mockImplementation(name => original(name).filter(sub => sub.subscriberId === 'alpha'));
    const other = new Worker(instance, { workerId: 'outbox-other', outboxBatchSize: 8, concurrency: 8 });
    const relays = await Promise.all([worker.relayOutbox(), other.relayOutbox()]);
    expect(relays.reduce((total, result) => total + result.enqueued, 0)).toBe(2);
    await makePendingJobsDue(instance);
    expect(await worker.runJobs()).toEqual({ processed: 1, failed: 1 });
    expect((await instance.database.db.execute<{ status: string }>(sql`
      SELECT status FROM platform_jobs WHERE dedupe_key = ${`evt:${id}:beta`}
    `)).rows).toEqual([{ status: 'quarantined' }]);
    await expect(redrive(instance, { outboxId: id, subscriberIds: ['alpha', 'beta'], evidence: 'beta is still absent' }))
      .rejects.toThrow('subscriber_missing:beta');
    expect((await instance.database.db.execute<{ status: string }>(sql`
      SELECT status FROM platform_jobs WHERE dedupe_key = ${`evt:${id}:beta`}
    `)).rows).toEqual([{ status: 'quarantined' }]);
    subscriptions.mockRestore();
    await redrive(instance, { outboxId: id, subscriberIds: ['alpha', 'beta'], evidence: 'subscriber beta restored in test' });
    await makePendingJobsDue(instance);
    expect(await worker.runJobs()).toEqual({ processed: 1, failed: 0 });
    expect(handled.filter(call => call.subscriber === 'beta').map(call => call.key)).toEqual([`evt:${id}:beta`]);
    expect((await instance.database.db.execute<{ action: string }>(sql`
      SELECT action FROM platform_outbox_quarantine_audit WHERE outbox_id = ${id} ORDER BY created_at
    `)).rows.map(row => row.action)).toContain('redrive_delivery');
  });

  it('lists job quarantine metadata only and routes event delivery recovery through the audited outbox command', async () => {
    const { instance, worker } = await setup();
    const id = await emit(instance);
    const actor = { id: 'ops', type: 'service' as const, displayName: 'ops', permissions: ['*'] };
    const original = instance.events.subscribersFor.bind(instance.events);
    const subscriptions = vi.spyOn(instance.events, 'subscribersFor').mockImplementation(name =>
      original(name).filter(sub => sub.subscriberId === 'alpha'));
    try {
      await worker.relayOutbox();
      await makePendingJobsDue(instance);
      expect(await worker.runJobs()).toEqual({ processed: 1, failed: 1 });
      const jobId = (await instance.database.db.execute<{ id: string }>(sql`
        SELECT id FROM platform_jobs WHERE dedupe_key = ${`evt:${id}:beta`}
      `)).rows[0]!.id;

      const listed = await instance.queries.execute<{ items: Array<Record<string, unknown>>; total: number }>(
        'platform.jobs.listQuarantinedJobs', {}, { actor },
      );
      const job = listed.items.find(item => item.id === jobId);
      expect(job).toMatchObject({ id: jobId, type: 'platform.event.deliver', reason: 'subscriber_missing' });
      expect(job).not.toHaveProperty('payload');
      const outboxFailures = await instance.queries.execute<{ items: Array<Record<string, unknown>>; total: number }>(
        'platform.outbox.listFailures', {}, { actor },
      );
      const deliveryFailure = outboxFailures.items.find(item => item.id === id);
      expect(deliveryFailure).toMatchObject({ id, status: 'relayed', reason: 'subscriber_missing', subscriberIds: ['alpha', 'beta'] });
      expect(deliveryFailure).not.toHaveProperty('payload');
      await expect(instance.commands.execute('platform.jobs.redriveQuarantinedJob', { jobId }, {
        actor: { ...actor, permissions: ['jobs:read'] }, idempotencyKey: randomUUID(),
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });

      await expect(instance.commands.execute('platform.jobs.redriveQuarantinedJob', { jobId }, {
        actor, idempotencyKey: randomUUID(),
      })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('platform.outbox.redriveFailure') });
      expect((await instance.database.db.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count FROM platform_audit_log
        WHERE action = 'jobs.quarantine.redriven' AND resource_id = ${jobId}
      `)).rows).toEqual([{ count: '0' }]);
    } finally {
      subscriptions.mockRestore();
    }
    const idempotencyKey = randomUUID();
    const first = await instance.commands.execute('platform.outbox.redriveFailure', {
      outboxId: id, subscriberIds: ['alpha', 'beta'], evidence: 'subscriber beta restored in test',
    }, { actor, idempotencyKey });
    const second = await instance.commands.execute('platform.outbox.redriveFailure', {
      outboxId: id, subscriberIds: ['alpha', 'beta'], evidence: 'subscriber beta restored in test',
    }, { actor, idempotencyKey });
    expect(first).toEqual({ outboxId: id, status: 'relayed' });
    expect(second).toEqual(first);
    expect((await instance.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_audit_log
      WHERE action = 'outbox.failure.redriven' AND resource_id = ${id}
    `)).rows).toEqual([{ count: '1' }]);
    expect((await instance.database.db.execute<{ action: string }>(sql`
      SELECT action FROM platform_outbox_quarantine_audit WHERE outbox_id = ${id}
    `)).rows).toEqual([{ action: 'redrive_delivery' }]);

    const cleanId = randomUUID();
    await instance.database.db.execute(sql`
      INSERT INTO platform_outbox (id, event_name, event_version, payload, actor_id, correlation_id, subscriber_ids, status)
      VALUES (${cleanId}, ${EVENT.name}, 1, '{"value":"x"}'::jsonb, 'ops', 'ops', '["alpha","beta"]'::jsonb, 'relayed')
    `);
    const unrelatedJobId = randomUUID();
    const unrelatedOccurrenceId = randomUUID();
    await instance.database.db.execute(sql`
      INSERT INTO platform_jobs (id, type, payload, payload_version, dedupe_key, status, occurrence_id)
      VALUES (${unrelatedJobId}, 'test.unrelated', '{}'::jsonb, 1, ${`evt:${cleanId}:not-a-delivery`}, 'quarantined', ${unrelatedOccurrenceId})
    `);
    await instance.database.db.execute(sql`
      INSERT INTO platform_job_quarantine (job_id, occurrence_id, type, payload, payload_version, reason)
      VALUES (${unrelatedJobId}, ${unrelatedOccurrenceId}, 'test.unrelated', '{}'::jsonb, 1, 'unrelated')
    `);
    const failuresAfterUnrelatedJob = await instance.queries.execute<{ items: Array<Record<string, unknown>> }>(
      'platform.outbox.listFailures', {}, { actor },
    );
    expect(failuresAfterUnrelatedJob.items.find(item => item.id === cleanId)).toBeUndefined();
    await expect(instance.commands.execute('platform.outbox.redriveFailure', {
      outboxId: cleanId, subscriberIds: ['alpha', 'beta'], evidence: 'must not audit a clean relayed event',
    }, { actor, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('no quarantined delivery') });
    expect((await instance.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_outbox_quarantine_audit WHERE outbox_id = ${cleanId}
    `)).rows).toEqual([{ count: '0' }]);

    await makePendingJobsDue(instance);
    expect(await worker.runJobs()).toEqual({ processed: 1, failed: 0 });
    expect(handled.filter(call => call.subscriber === 'beta').map(call => call.key)).toContain(`evt:${id}:beta`);
  });

  it('redrives a non-delivery job quarantine through its own idempotent, audited command', async () => {
    const { instance } = await setup();
    const actor = { id: 'ops', type: 'service' as const, displayName: 'ops', permissions: ['*'] };
    const jobId = randomUUID();
    const occurrenceId = randomUUID();
    await instance.database.db.execute(sql`
      INSERT INTO platform_jobs (id, type, payload, payload_version, status, occurrence_id)
      VALUES (${jobId}, 'test.generic-quarantine', '{"value":"x"}'::jsonb, 1, 'quarantined', ${occurrenceId})
    `);
    await instance.database.db.execute(sql`
      INSERT INTO platform_job_quarantine (job_id, occurrence_id, type, payload, payload_version, reason)
      VALUES (${jobId}, ${occurrenceId}, 'test.generic-quarantine', '{"value":"x"}'::jsonb, 1, 'invalid_payload')
    `);
    const listed = await instance.queries.execute<{ items: Array<Record<string, unknown>> }>(
      'platform.jobs.listQuarantinedJobs', {}, { actor },
    );
    expect(listed.items.find(item => item.id === jobId)).toMatchObject({ type: 'test.generic-quarantine', reason: 'invalid_payload' });
    expect(listed.items.find(item => item.id === jobId)).not.toHaveProperty('payload');
    const idempotencyKey = randomUUID();
    const first = await instance.commands.execute('platform.jobs.redriveQuarantinedJob', { jobId }, { actor, idempotencyKey });
    const second = await instance.commands.execute('platform.jobs.redriveQuarantinedJob', { jobId }, { actor, idempotencyKey });
    expect(first).toEqual({ jobId, status: 'pending' });
    expect(second).toEqual(first);
    expect((await instance.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_audit_log
      WHERE action = 'jobs.quarantine.redriven' AND resource_id = ${jobId}
    `)).rows).toEqual([{ count: '1' }]);
  });

  it('lists outbox failure metadata only and permits audited redrive only after frozen snapshot validation', async () => {
    const { instance } = await setup();
    const actor = { id: 'ops', type: 'service' as const, displayName: 'ops', permissions: ['*'] };
    const id = await emit(instance);
    await instance.database.db.execute(sql`
      UPDATE platform_outbox SET status = 'dead', attempts = 10, last_error = 'relay exhausted' WHERE id = ${id}
    `);

    const listed = await instance.queries.execute<{ items: Array<Record<string, unknown>>; total: number }>(
      'platform.outbox.listFailures', {}, { actor },
    );
    const failure = listed.items.find(item => item.id === id);
    expect(failure).toMatchObject({ id, eventName: EVENT.name, status: 'dead', attempts: 10, subscriberIds: ['alpha', 'beta'] });
    expect(failure).not.toHaveProperty('payload');

    await expect(instance.commands.execute('platform.outbox.redriveFailure', {
      outboxId: id, subscriberIds: ['beta', 'alpha'], evidence: 'must use the persisted canonical snapshot',
    }, { actor, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect((await instance.database.db.execute<{ status: string }>(sql`
      SELECT status FROM platform_outbox WHERE id = ${id}
    `)).rows).toEqual([{ status: 'dead' }]);
    expect((await instance.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_outbox_quarantine_audit WHERE outbox_id = ${id}
    `)).rows).toEqual([{ count: '0' }]);

    const idempotencyKey = randomUUID();
    const input = { outboxId: id, subscriberIds: ['alpha', 'beta'], evidence: 'relay cause repaired' };
    const first = await instance.commands.execute('platform.outbox.redriveFailure', input, { actor, idempotencyKey });
    const second = await instance.commands.execute('platform.outbox.redriveFailure', input, { actor, idempotencyKey });
    expect(first).toEqual({ outboxId: id, status: 'pending' });
    expect(second).toEqual(first);
    expect((await instance.database.db.execute<{ status: string; attempts: number }>(sql`
      SELECT status, attempts FROM platform_outbox WHERE id = ${id}
    `)).rows).toEqual([{ status: 'pending', attempts: 0 }]);
    expect((await instance.database.db.execute<{ action: string }>(sql`
      SELECT action FROM platform_outbox_quarantine_audit WHERE outbox_id = ${id}
    `)).rows).toEqual([{ action: 'retry_dead' }]);
    expect((await instance.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_audit_log
      WHERE action = 'outbox.failure.redriven' AND resource_id = ${id}
    `)).rows).toEqual([{ count: '1' }]);

    const invalidId = randomUUID();
    await instance.database.db.execute(sql`
      INSERT INTO platform_outbox (id, event_name, event_version, payload, actor_id, correlation_id, subscriber_ids, status)
      VALUES (${invalidId}, 'unknown.event.v1', 1, '{}'::jsonb, 'ops', 'ops', '[]'::jsonb, 'quarantined')
    `);
    await instance.database.db.execute(sql`
      INSERT INTO platform_outbox_quarantine (outbox_id, event_name, event_version, payload, subscriber_ids, reason)
      VALUES (${invalidId}, 'unknown.event.v1', 1, '{}'::jsonb, '[]'::jsonb, 'event_unknown')
    `);
    await expect(instance.commands.execute('platform.outbox.redriveFailure', {
      outboxId: invalidId, subscriberIds: [], evidence: 'must remain quarantined',
    }, { actor, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect((await instance.database.db.execute<{ status: string }>(sql`
      SELECT status FROM platform_outbox WHERE id = ${invalidId}
    `)).rows).toEqual([{ status: 'quarantined' }]);
    expect((await instance.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_outbox_quarantine_audit WHERE outbox_id = ${invalidId}
    `)).rows).toEqual([{ count: '0' }]);
  });

  it('quarantines unknown/version-invalid/payload-invalid events without starving a normal event', async () => {
    const { instance, worker } = await setup();
    const normal = await emit(instance);
    const invalid = [
      ['unknown.event.v1', 1, { value: 'x' }],
      [EVENT.name, 99, { value: 'x' }],
      [EVENT.name, 1, { value: 42 }],
    ] as const;
    for (const [name, version, payload] of invalid) await instance.database.db.execute(sql`
      INSERT INTO platform_outbox (id, event_name, event_version, payload, actor_id, correlation_id, subscriber_ids)
      VALUES (${randomUUID()}, ${name}, ${version}, ${JSON.stringify(payload)}::jsonb, 'test', 'test', '[]'::jsonb)
    `);
    expect((await worker.relayOutbox()).relayed).toBe(1);
    expect((await instance.database.db.execute<{ reason: string }>(sql`
      SELECT reason FROM platform_outbox_quarantine ORDER BY created_at
    `)).rows.map(row => row.reason).sort()).toEqual(['event_payload_invalid', 'event_unknown', 'event_version_invalid']);
    await makePendingJobsDue(instance);
    expect(await worker.runJobs()).toEqual({ processed: 2, failed: 0 });
    expect(handled.filter(call => call.key?.startsWith(`evt:${normal}:`))).toHaveLength(2);
  });

  it('treats [] as a legal terminal snapshot and NULL legacy snapshots as quarantine until audited repair', async () => {
    const { instance, worker } = await setup();
    const empty = randomUUID();
    const legacy = randomUUID();
    await instance.database.db.execute(sql`
      INSERT INTO platform_outbox (id, event_name, event_version, payload, actor_id, correlation_id, subscriber_ids)
      VALUES (${empty}, ${EVENT.name}, 1, '{"value":"x"}'::jsonb, 'test', 'test', '[]'::jsonb)
    `);
    await instance.database.db.execute(sql`
      INSERT INTO platform_outbox (id, event_name, event_version, payload, actor_id, correlation_id, subscriber_ids)
      VALUES (${legacy}, ${EVENT.name}, 1, '{"value":"x"}'::jsonb, 'test', 'test', NULL)
    `);
    await instance.database.db.execute(sql`UPDATE platform_outbox SET occurred_at = '2000-01-01T00:00:00.000Z' WHERE id = ${legacy}`);
    expect(await worker.relayOutbox()).toEqual({ relayed: 1, enqueued: 0 });
    expect((await instance.outbox.inspectQuarantine(instance.database.db, legacy))?.reason).toBe('legacy_subscriber_snapshot_unknown');
    await redrive(instance, { outboxId: legacy, subscriberIds: ['alpha'], evidence: 'operator verified pre-B04 subscriber list' });
    expect(await worker.relayOutbox()).toEqual({ relayed: 1, enqueued: 1 });
    expect((await instance.database.db.execute<{ action: string }>(sql`
      SELECT action FROM platform_outbox_quarantine_audit WHERE outbox_id = ${legacy} ORDER BY created_at
    `)).rows.map(row => row.action)).toEqual(['repair_snapshot', 'redrive']);
  });

  it('refuses to repair an unknown legacy snapshot to zero subscribers without an explicit acknowledgement', async () => {
    const { instance, worker } = await setup();
    const legacy = randomUUID();
    await instance.database.db.execute(sql`
      INSERT INTO platform_outbox (id, event_name, event_version, payload, actor_id, correlation_id, subscriber_ids)
      VALUES (${legacy}, ${EVENT.name}, 1, '{"value":"x"}'::jsonb, 'test', 'test', NULL)
    `);
    await instance.database.db.execute(sql`UPDATE platform_outbox SET occurred_at = '2000-01-01T00:00:00.000Z' WHERE id = ${legacy}`);
    expect(await worker.relayOutbox()).toEqual({ relayed: 0, enqueued: 0 });

    await expect(redrive(instance, {
      outboxId: legacy, subscriberIds: [], evidence: 'operator believes nobody subscribed',
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('acknowledgeEmptyFanout') });
    expect((await instance.database.db.execute<{ subscriber_ids: unknown }>(sql`
      SELECT subscriber_ids FROM platform_outbox WHERE id = ${legacy}
    `)).rows).toEqual([{ subscriber_ids: null }]);
    expect((await instance.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_outbox_quarantine_audit WHERE outbox_id = ${legacy}
    `)).rows).toEqual([{ count: '0' }]);

    await redrive(instance, {
      outboxId: legacy, subscriberIds: [], evidence: 'operator verified nobody subscribed', acknowledgeEmptyFanout: true,
    });
    expect((await instance.database.db.execute<{ action: string }>(sql`
      SELECT action FROM platform_outbox_quarantine_audit WHERE outbox_id = ${legacy} ORDER BY created_at
    `)).rows.map(row => row.action)).toEqual(['repair_snapshot', 'redrive']);
  });

  it('reconstructs only a uniquely trusted effective release snapshot', async () => {
    const { instance, worker } = await setup();
    await instance.activateRelease('apply');
    const trusted = randomUUID();
    await instance.database.db.execute(sql`
      INSERT INTO platform_outbox (id, event_name, event_version, payload, actor_id, correlation_id, occurred_at, subscriber_ids)
      VALUES (${trusted}, ${EVENT.name}, 1, '{"value":"x"}'::jsonb, 'test', 'test', now(), NULL)
    `);
    expect(await worker.relayOutbox()).toEqual({ relayed: 1, enqueued: 2 });
    expect((await instance.database.db.execute<{ subscriber_ids: string[] }>(sql`
      SELECT subscriber_ids FROM platform_outbox WHERE id = ${trusted}
    `)).rows).toEqual([{ subscriber_ids: ['alpha', 'beta'] }]);
  });

  it.each([
    ['checksum drift', async (instance: Runtime) => {
      await instance.database.db.execute(sql`UPDATE platform_release_history SET effective_manifest_checksum = ${`sha256:${'0'.repeat(64)}`}`);
    }],
    ['invalid ownership', async (instance: Runtime) => {
      await instance.database.db.execute(sql`UPDATE platform_release_history
        SET effective_manifest = jsonb_set(effective_manifest, '{owners,1,owner,work,subscriberIds}', '["alpha"]'::jsonb)`);
    }],
    ['invalid schema', async (instance: Runtime) => {
      await instance.database.db.execute(sql`UPDATE platform_release_history SET effective_manifest = effective_manifest - 'schemaVersion'`);
    }],
    ['ambiguous recorded time', async (instance: Runtime) => {
      await instance.database.db.execute(sql`INSERT INTO platform_release_history
        (release_id, release_version, base_version, build_manifest_checksum, effective_manifest_checksum, effective_manifest, recorded_at)
        SELECT release_id, release_version, base_version, build_manifest_checksum, effective_manifest_checksum, effective_manifest, recorded_at
        FROM platform_release_history`);
    }],
  ])('quarantines a NULL legacy snapshot with %s release history', async (_label, corrupt) => {
    const { instance, worker } = await setup();
    await instance.activateRelease('apply');
    await corrupt(instance);
    const legacy = randomUUID();
    await instance.database.db.execute(sql`
      INSERT INTO platform_outbox (id, event_name, event_version, payload, actor_id, correlation_id, occurred_at, subscriber_ids)
      VALUES (${legacy}, ${EVENT.name}, 1, '{"value":"x"}'::jsonb, 'test', 'test', now(), NULL)
    `);
    expect(await worker.relayOutbox()).toEqual({ relayed: 0, enqueued: 0 });
    expect((await instance.outbox.inspectQuarantine(instance.database.db, legacy))?.reason).toBe('legacy_subscriber_snapshot_unknown');
  });

  it('rejects frozen-snapshot caller omissions, extras, and emptiness before redrive or audit', async () => {
    const { instance, worker } = await setup();
    const id = await emit(instance);
    const original = instance.events.subscribersFor.bind(instance.events);
    const subscriptions = vi.spyOn(instance.events, 'subscribersFor').mockImplementation(name => original(name).filter(sub => sub.subscriberId === 'alpha'));
    await worker.relayOutbox();
    await makePendingJobsDue(instance);
    await worker.runJobs();
    const before = await instance.database.db.execute<{ status: string; dedupe_key: string }>(sql`
      SELECT status, dedupe_key FROM platform_jobs WHERE dedupe_key LIKE ${`evt:${id}:%`} ORDER BY dedupe_key
    `);
    const auditBefore = await instance.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_outbox_quarantine_audit WHERE outbox_id = ${id}
    `);
    for (const subscriberIds of [[], ['alpha'], ['alpha', 'beta', 'extra']]) {
      await expect(redrive(instance, { outboxId: id, subscriberIds, evidence: 'must not alter frozen snapshot' }))
        .rejects.toThrow('subscriber snapshot');
      expect((await instance.database.db.execute<{ status: string; dedupe_key: string }>(sql`
        SELECT status, dedupe_key FROM platform_jobs WHERE dedupe_key LIKE ${`evt:${id}:%`} ORDER BY dedupe_key
      `)).rows).toEqual(before.rows);
      expect((await instance.database.db.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count FROM platform_outbox_quarantine_audit WHERE outbox_id = ${id}
      `)).rows).toEqual(auditBefore.rows);
    }
    subscriptions.mockRestore();
  });

  it('keeps the event subscriber key stable after an effect commits before a retry, while business not-found remains retryable', async () => {
    const { instance, worker } = await setup();
    const id = await emit(instance);
    alphaFailure = 'once';
    await worker.relayOutbox();
    await makePendingJobsDue(instance);
    expect(await worker.runJobs()).toEqual({ processed: 1, failed: 1 });
    await instance.database.db.execute(sql`UPDATE platform_jobs SET run_at = now() - interval '1 second' WHERE dedupe_key = ${`evt:${id}:alpha`}`);
    expect(await worker.runJobs()).toEqual({ processed: 1, failed: 0 });
    expect((await instance.database.db.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM outbox_delivery_effects`)).rows).toEqual([{ count: '1' }]);
    expect(handled.filter(call => call.subscriber === 'alpha').map(call => call.key)).toEqual([`evt:${id}:alpha`, `evt:${id}:alpha`]);

    const second = await emit(instance);
    alphaFailure = 'not-found';
    await worker.relayOutbox();
    await makePendingJobsDue(instance);
    expect(await worker.runJobs()).toEqual({ processed: 1, failed: 1 });
    expect((await instance.database.db.execute<{ status: string }>(sql`
      SELECT status FROM platform_jobs WHERE dedupe_key = ${`evt:${second}:alpha`}
    `)).rows).toEqual([{ status: 'pending' }]);
    expect((await instance.database.db.execute(sql`SELECT * FROM platform_job_quarantine WHERE job_id IN (
      SELECT id FROM platform_jobs WHERE dedupe_key = ${`evt:${second}:alpha`}
    )`)).rows).toEqual([]);
  });
});
