import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger, PlatformError } from '@storeweave/contracts';
import { createRuntime, JobRegistry, Worker, type Runtime } from '@storeweave/kernel';
import { createTestDatabase } from './helpers';

const VERSIONED = 'test.payload.versioned';
const MISSING_UPGRADE = 'test.payload.missing-upgrade';
const HANDLER_NOT_FOUND = 'test.payload.handler-not-found';
const v1 = z.object({ value: z.string() }).strict();
const v2 = z.object({ message: z.string() }).strict();
const runtimes: Runtime[] = [];

afterEach(async () => { await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close())); });

async function runtime() {
  const url = await createTestDatabase();
  const handled: unknown[] = [];
  const instance = await createRuntime({
    release: { id: 'payload-contract', version: '1.0.0', buildManifestChecksum: `sha256:${'2'.repeat(64)}` },
    roles: BASE_ROLES,
    config: baseConfigSchema.parse({ version: 1, store: { id: 'payload-contract', name: 'Payload contract' }, database: { url }, logging: { level: 'error' } }),
    secrets: { get: () => undefined, has: () => false, listNames: () => [] }, logger: noopLogger, availableExtensions: {},
    modules: [{
      name: 'payload-contract', version: '1.0.0', baseVersionRange: '^1.0.0',
      jobs: [
        { type: VERSIONED, handler: async payload => { handled.push(payload); }, jobContractV1: {
          currentVersion: 2, versions: { 1: v1, 2: v2 }, upgrades: { 1: payload => ({ message: (payload as { value: string }).value }) },
        } },
        { type: MISSING_UPGRADE, handler: async payload => { handled.push(payload); }, jobContractV1: {
          currentVersion: 2, versions: { 1: v1, 2: v2 },
        } },
        { type: HANDLER_NOT_FOUND, handler: async () => { throw PlatformError.notFound('business record', 'missing'); }, jobContractV1: {
          currentVersion: 1, versions: { 1: z.object({}).strict() },
        } },
      ],
    }],
  });
  runtimes.push(instance);
  await instance.migrate();
  return { instance, handled };
}

async function legacyRuntime() {
  const url = await createTestDatabase();
  const instance = await createRuntime({
    release: { id: 'legacy-payload-contract', version: '1.0.0', buildManifestChecksum: `sha256:${'3'.repeat(64)}` },
    roles: BASE_ROLES,
    config: baseConfigSchema.parse({ version: 1, store: { id: 'legacy-payload-contract', name: 'Legacy payload contract' }, database: { url }, logging: { level: 'error' } }),
    secrets: { get: () => undefined, has: () => false, listNames: () => [] }, logger: noopLogger, availableExtensions: {},
    modules: [{ name: 'legacy-owner', version: '1.0.0', baseVersionRange: '^1.0.0', jobs: [
      { type: 'ext.legacy-owner.send', handler: async () => undefined },
    ] }],
  });
  runtimes.push(instance);
  await instance.migrate();
  return instance;
}

async function insertPersisted(instance: Runtime, type: string, payload: unknown, payloadVersion: number) {
  const id = randomUUID();
  await instance.database.db.execute(sql`
    INSERT INTO platform_jobs (id, type, payload, payload_version)
    VALUES (${id}, ${type}, ${JSON.stringify(payload)}::jsonb, ${payloadVersion})
  `);
  return id;
}

describe('versioned job payloads', () => {
  it('upgrades a valid v1 payload before the handler, while enqueue writes the owner current version', async () => {
    const { instance, handled } = await runtime();
    const legacyId = await insertPersisted(instance, VERSIONED, { value: 'from-v1' }, 1);
    const enqueued = await instance.database.transaction(tx => instance.jobs.enqueue(tx, { type: VERSIONED, payload: { message: 'new' } }));
    const worker = new Worker(instance, { workerId: 'payload-version-worker' });
    expect(await worker.runJobs()).toEqual({ processed: 2, failed: 0 });
    expect(handled).toHaveLength(2);
    expect(handled).toEqual(expect.arrayContaining([{ message: 'from-v1' }, { message: 'new' }]));
    const versions = await instance.database.db.execute<{ id: string; payload_version: number; status: string }>(sql`
      SELECT id, payload_version, status FROM platform_jobs WHERE id IN (${legacyId}, ${enqueued.id}) ORDER BY id
    `);
    expect(versions.rows).toEqual(expect.arrayContaining([
      { id: legacyId, payload_version: 1, status: 'completed' },
      { id: enqueued.id, payload_version: 2, status: 'completed' },
    ]));
  });

  it('durably quarantines unknown, invalid, and missing-upgrader payloads without invoking their handlers', async () => {
    const { instance, handled } = await runtime();
    const invalid = await insertPersisted(instance, VERSIONED, { value: 42 }, 1);
    const unknownVersion = await insertPersisted(instance, VERSIONED, { message: 'future' }, 99);
    const missingUpgrade = await insertPersisted(instance, MISSING_UPGRADE, { value: 'orphan' }, 1);
    const unknownType = await insertPersisted(instance, 'test.payload.unknown-owner', { value: 'no handler' }, 1);
    const worker = new Worker(instance, { workerId: 'payload-quarantine-worker', concurrency: 8 });
    expect(await worker.runJobs()).toEqual({ processed: 0, failed: 4 });
    expect(handled).toEqual([]);
    const quarantined = await instance.database.db.execute<{
      job_id: string; type: string; payload: unknown; payload_version: number; reason: string;
    }>(sql`SELECT job_id, type, payload, payload_version, reason FROM platform_job_quarantine ORDER BY job_id`);
    expect(quarantined.rows).toHaveLength(4);
    expect(quarantined.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ job_id: invalid, type: VERSIONED, payload: { value: 42 }, payload_version: 1, reason: expect.stringContaining('invalid') }),
      expect.objectContaining({ job_id: unknownVersion, type: VERSIONED, payload: { message: 'future' }, payload_version: 99, reason: expect.stringContaining('unknown payload version') }),
      expect.objectContaining({ job_id: missingUpgrade, type: MISSING_UPGRADE, payload: { value: 'orphan' }, payload_version: 1, reason: expect.stringContaining('missing payload upgrader') }),
      expect.objectContaining({ job_id: unknownType, type: 'test.payload.unknown-owner', payload: { value: 'no handler' }, payload_version: 1 }),
    ]));
    const statuses = await instance.database.db.execute<{ status: string }>(sql`SELECT status FROM platform_jobs WHERE id IN (${invalid}, ${unknownVersion}, ${missingUpgrade}, ${unknownType})`);
    expect(statuses.rows).toEqual(Array.from({ length: 4 }, () => ({ status: 'quarantined' })));
  });

  it('fail-stops when a fenced quarantine outcome is stale, without evidence or another claim', async () => {
    const { instance, handled } = await runtime();
    const invalid = await insertPersisted(instance, VERSIONED, { value: 42 }, 1);
    await instance.database.db.execute(sql`UPDATE platform_jobs SET run_at = now() - interval '1 second' WHERE id = ${invalid}`);
    const later = await instance.database.transaction(tx => instance.jobs.enqueue(tx, { type: VERSIONED, payload: { message: 'later' } }));
    vi.spyOn(instance.jobs, 'quarantine').mockResolvedValue({ applied: false });
    const worker = new Worker(instance, { workerId: 'payload-stale-quarantine-worker', concurrency: 1 });

    await expect(worker.runJobs()).rejects.toThrow(`Lost fenced quarantine for ${invalid}`);
    await expect(worker.waitForFatal()).resolves.toMatchObject({ name: 'WorkerFatalError' });
    expect(handled).toEqual([]);
    expect((await instance.database.db.execute(sql`SELECT job_id FROM platform_job_quarantine WHERE job_id = ${invalid}`)).rows).toEqual([]);
    expect((await instance.database.db.execute<{ status: string }>(sql`SELECT status FROM platform_jobs WHERE id = ${later.id}`)).rows)
      .toEqual([{ status: 'pending' }]);
  });

  it('retries a handler PlatformError.notFound instead of misclassifying it as an unknown job', async () => {
    const { instance } = await runtime();
    const id = (await instance.database.transaction(tx => instance.jobs.enqueue(tx, {
      type: HANDLER_NOT_FOUND, payload: {}, maxAttempts: 2,
    }))).id;
    const worker = new Worker(instance, { workerId: 'handler-not-found-worker' });
    expect(await worker.runJobs()).toEqual({ processed: 0, failed: 1 });
    const job = await instance.database.db.execute<{ status: string }>(sql`SELECT status FROM platform_jobs WHERE id = ${id}`);
    expect(job.rows).toEqual([{ status: 'pending' }]);
    const evidence = await instance.database.db.execute(sql`SELECT job_id FROM platform_job_quarantine WHERE job_id = ${id}`);
    expect(evidence.rows).toEqual([]);
  });

  it('rejects a legacy owner before worker start/tick can create heartbeat, relay, schedule, or claim side effects', async () => {
    const instance = await legacyRuntime();
    const worker = new Worker(instance, { workerId: 'legacy-cutover-worker' });
    expect(() => worker.start()).toThrow('legacy-owner:ext.legacy-owner.send');
    await expect(worker.tick()).rejects.toThrow('legacy-owner:ext.legacy-owner.send');
    const effects = await instance.database.db.execute<{ heartbeats: string; jobs: string }>(sql`
      SELECT (SELECT count(*)::text FROM platform_worker_heartbeat WHERE worker_id = 'legacy-cutover-worker') AS heartbeats,
             (SELECT count(*)::text FROM platform_jobs) AS jobs
    `);
    expect(effects.rows).toEqual([{ heartbeats: '0', jobs: '0' }]);
  });

  it('names legacy extension owners before fenced dispatcher cutover', () => {
    const registry = new JobRegistry();
    registry.register('ext.legacy.send', async () => undefined, 'legacy-extension');
    expect(() => registry.assertPayloadDispatchReady()).toThrow('legacy-extension:ext.legacy.send');
  });
});
