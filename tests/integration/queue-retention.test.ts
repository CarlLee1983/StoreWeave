import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Worker } from '@storeweave/kernel';
import type { Tx } from '@storeweave/contracts';
import { z } from 'zod';
import { createHarness, type TestHarness } from './helpers';

let h: TestHarness;
beforeEach(async () => { h = await createHarness(); }, 300_000);
afterEach(async () => { await h?.close(); });

async function enqueue(key = `retention-${randomUUID()}`, type = 'platform.event.deliver', payload: unknown = { key }) {
  return h.runtime.database.transaction(tx => h.runtime.jobs.enqueue(tx, {
    type, payload, dedupeKey: key, runAt: new Date(Date.now() - 1_000),
  }));
}
async function claim(id: string) {
  return (await h.runtime.database.transaction(tx => h.runtime.jobs.claim(tx, 'retention-test', 8, undefined, 60)))
    .find(job => job.id === id)!;
}
async function state(id: string) {
  const result = await h.runtime.database.db.execute<{
    status: string; payload: unknown; occurrence_id: string; retain_until: Date | null; dedupe_until: Date | null;
    deferred_at: Date | null; last_error: string | null;
  }>(sql`SELECT status, payload, occurrence_id, retain_until, dedupe_until, deferred_at, last_error
    FROM platform_jobs WHERE id = ${id}`);
  return result.rows[0] ?? null;
}
function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms)),
  ]);
}

describe('queue retention and cancellation core', () => {
  it('tombstones terminal payload at retention, keeps its dedupe identity, and permits a new id after horizon', async () => {
    const key = `retention-horizon-${randomUUID()}`;
    const first = await enqueue(key, 'platform.event.deliver', { revision: 1 });
    await h.runtime.jobs.complete(h.runtime.database.db, await claim(first.id));
    expect(await enqueue(key, 'platform.event.deliver', { ignored: true })).toEqual({ id: first.id, deduped: true });
    await h.runtime.database.db.execute(sql`UPDATE platform_jobs SET retain_until = now() - interval '1 second' WHERE id = ${first.id}`);
    await h.worker.tick();
    // node-postgres deliberately returns timestamptz as a string in this test
    // path; the queue contract is the persisted instant, not a JS Date shape.
    expect(await state(first.id)).toMatchObject({ status: 'dedupe_retained', payload: null, retain_until: null, dedupe_until: expect.any(String), deferred_at: null, last_error: null });
    const metadata = await h.runtime.jobs.getMetadata(h.runtime.database.db, first.id);
    expect(metadata).toMatchObject({ id: first.id, status: 'dedupe_retained', dedupeKey: key });
    expect(metadata).not.toHaveProperty('payload');
    expect(metadata).not.toHaveProperty('lastError');
    expect(await h.runtime.jobs.stats(h.runtime.database.db)).toMatchObject({ dedupe_retained: 1 });
    expect(await enqueue(key, 'platform.event.deliver', { ignored: true })).toEqual({ id: first.id, deduped: true });
    await h.runtime.database.db.execute(sql`UPDATE platform_jobs SET dedupe_until = now() - interval '1 second' WHERE id = ${first.id}`);
    await h.worker.tick();
    expect(await state(first.id)).toBeNull();
    expect(await enqueue(key, 'platform.event.deliver', { revision: 2 })).toMatchObject({ deduped: false });

    const withoutDedupe = await h.runtime.database.transaction(tx => h.runtime.jobs.enqueue(tx, {
      type: 'platform.event.deliver', payload: { transient: true }, runAt: new Date(Date.now() - 1_000),
    }));
    await h.runtime.jobs.complete(h.runtime.database.db, await claim(withoutDedupe.id));
    await h.runtime.database.db.execute(sql`UPDATE platform_jobs SET retain_until = now() - interval '1 second' WHERE id = ${withoutDedupe.id}`);
    await h.worker.tick();
    expect(await state(withoutDedupe.id)).toBeNull();
  });

  it('replaceExisting revives a tombstone and cleanup preserves active, dead, and quarantined rows', async () => {
    const key = `retention-replace-${randomUUID()}`;
    const retained = await enqueue(key);
    await h.runtime.jobs.complete(h.runtime.database.db, await claim(retained.id));
    await h.runtime.database.db.execute(sql`UPDATE platform_jobs SET retain_until = now() - interval '1 second' WHERE id = ${retained.id}`);
    await h.worker.tick();
    const before = (await state(retained.id))!;
    expect(await h.runtime.database.transaction(tx => h.runtime.jobs.enqueue(tx, {
      type: 'platform.event.deliver', payload: { revision: 3 }, dedupeKey: key, replaceExisting: true,
    }))).toEqual({ id: retained.id, deduped: true });
    expect(await state(retained.id)).toMatchObject({ status: 'pending', payload: { revision: 3 }, retain_until: null, dedupe_until: null,
      occurrence_id: expect.not.stringMatching(before.occurrence_id) });

    const raceKey = `retention-race-${randomUUID()}`;
    const race = await enqueue(raceKey);
    await h.runtime.jobs.complete(h.runtime.database.db, await claim(race.id));
    await h.runtime.database.db.execute(sql`UPDATE platform_jobs SET retain_until = now() - interval '1 second' WHERE id = ${race.id}`);
    await Promise.all([
      h.runtime.database.transaction(tx => h.runtime.jobs.cleanupExpired(tx, 1)),
      h.runtime.database.transaction(tx => h.runtime.jobs.enqueue(tx, {
        type: 'platform.event.deliver', payload: { race: 'replacement' }, dedupeKey: raceKey, replaceExisting: true,
      })),
    ]);
    expect(await state(race.id)).toMatchObject({ status: 'pending', payload: { race: 'replacement' } });
    const raceCount = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_jobs WHERE dedupe_key = ${raceKey}
    `);
    expect(raceCount.rows[0]?.count).toBe('1');

    const active = await enqueue();
    await claim(active.id);
    const dead = await enqueue();
    await h.runtime.jobs.fail(h.runtime.database.db, await claim(dead.id), 'dead', true);
    const quarantined = await enqueue();
    await h.runtime.jobs.quarantine(h.runtime.database.db, await claim(quarantined.id), 'invalid payload');
    await h.runtime.database.db.execute(sql`UPDATE platform_jobs SET retain_until = now() - interval '1 second' WHERE id IN (${active.id}, ${dead.id}, ${quarantined.id})`);
    await h.worker.tick();
    await expect(state(active.id)).resolves.toMatchObject({ status: 'running' });
    await expect(state(dead.id)).resolves.toMatchObject({ status: 'dead' });
    await expect(state(quarantined.id)).resolves.toMatchObject({ status: 'quarantined' });
  });

  it('keeps an accepted running cancellation terminal when a later replacement races it', async () => {
    const key = `cancel-then-replace-${randomUUID()}`;
    const queued = await enqueue(key, 'platform.event.deliver', { revision: 1 });
    const running = await claim(queued.id);

    expect(await h.runtime.jobs.cancel(h.runtime.database.db, {
      jobId: queued.id, occurrenceId: running.occurrenceId,
    })).toMatchObject({ applied: true, status: 'running' });
    await h.runtime.database.transaction(tx => h.runtime.jobs.enqueue(tx, {
      type: 'platform.event.deliver', payload: { revision: 2 }, dedupeKey: key, replaceExisting: true,
    }));

    expect(await h.runtime.jobs.heartbeat(h.runtime.database.db, running)).toMatchObject({
      applied: true, cancelRequested: true,
    });
    expect(await h.runtime.jobs.complete(h.runtime.database.db, running)).toMatchObject({
      applied: true, status: 'cancelled',
    });
    expect(await state(queued.id)).toMatchObject({ status: 'cancelled', deferred_at: null });
  });

  it.each([false, true])('enqueues safely when cleanup removes an expired tombstone after its conflict (%s replaceExisting)', async (replaceExisting) => {
    const key = `cleanup-gap-${replaceExisting}-${randomUUID()}`;
    const retained = await enqueue(key, 'platform.event.deliver', { revision: 1 });
    await h.runtime.jobs.complete(h.runtime.database.db, await claim(retained.id));
    await h.runtime.database.db.execute(sql`UPDATE platform_jobs SET retain_until = now() - interval '1 second' WHERE id = ${retained.id}`);
    await h.worker.tick();
    await h.runtime.database.db.execute(sql`UPDATE platform_jobs SET dedupe_until = now() - interval '1 second' WHERE id = ${retained.id}`);

    const result = await h.runtime.database.transaction(async (tx) => {
      let statement = 0;
      // This is a true-PostgreSQL interleaving: the first INSERT observes the
      // unique tombstone, then another connection deletes it before this
      // transaction can lock it. PostgreSQL deliberately retains no row lock
      // for ON CONFLICT DO NOTHING, so this is a valid production schedule.
      const interleaved = {
        execute: async (...args: any[]) => {
          const outcome = await (tx.execute as any)(...args);
          statement += 1;
          if (statement === 1) await h.runtime.jobs.cleanupExpired(h.runtime.database.db, 1);
          return outcome;
        },
      } as Tx;
      return h.runtime.jobs.enqueue(interleaved, {
        type: 'platform.event.deliver', payload: { revision: 2 }, dedupeKey: key, replaceExisting,
      });
    });

    expect(result).toMatchObject({ deduped: false });
    expect(result.id).not.toBe(retained.id);
    expect(await state(result.id)).toMatchObject({ status: 'pending', payload: { revision: 2 } });
  });

  it('serializes dead-only retry and cooperatively aborts a fenced, deferred running cancellation on heartbeat', async () => {
    const dead = await enqueue();
    await h.runtime.jobs.fail(h.runtime.database.db, await claim(dead.id), 'permanent', true);
    const results = await Promise.allSettled([h.runtime.jobs.retryDead(h.runtime.database.db, dead.id), h.runtime.jobs.retryDead(h.runtime.database.db, dead.id)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await state(dead.id)).toMatchObject({ status: 'pending' });

    const pending = await enqueue();
    const pendingOccurrence = (await state(pending.id))!.occurrence_id;
    expect(await h.runtime.jobs.cancel(h.runtime.database.db, { jobId: pending.id, occurrenceId: pendingOccurrence })).toMatchObject({ applied: true, status: 'cancelled' });
    expect(await state(pending.id)).toMatchObject({ status: 'cancelled', retain_until: expect.any(String), dedupe_until: expect.any(String) });
    await expect(h.runtime.jobs.retryDead(h.runtime.database.db, pending.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const type = `test.cancel-${randomUUID()}`;
    h.runtime.jobRegistry.register(type, async (_payload, context) => {
      entered();
      await new Promise<void>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
    }, 'test', { currentVersion: 1, versions: { 1: z.object({}).strict() } });
    const runningKey = `running-${randomUUID()}`;
    const running = await enqueue(runningKey, type, {});
    const worker = new Worker(h.runtime, { workerId: 'cancel-observer', concurrency: 1, staleLockSeconds: 4, heartbeatIntervalMs: 1_200, databaseTimeoutMs: 500, abortGraceMs: 1_000 });
    const processed = worker.runJobs();
    try {
      await within(started, 5_000, 'cancel handler start');
      const occurrence = (await state(running.id))!.occurrence_id;
      await h.runtime.database.transaction(tx => h.runtime.jobs.enqueue(tx, {
        type, payload: { replacement: true }, dedupeKey: runningKey, replaceExisting: true,
      }));
      expect(await state(running.id)).toMatchObject({ status: 'running', deferred_at: expect.any(String) });
      expect(await h.runtime.jobs.cancel(h.runtime.database.db, { jobId: running.id, occurrenceId: occurrence })).toMatchObject({ applied: true, status: 'running' });
      await expect(within(processed, 5_000, 'cancelled worker completion')).resolves.toEqual({ processed: 0, failed: 1 });
      expect(await state(running.id)).toMatchObject({ status: 'cancelled', deferred_at: null });
      await expect(h.runtime.jobs.cancel(h.runtime.database.db, { jobId: running.id, occurrenceId: occurrence })).rejects.toMatchObject({ code: 'CONFLICT' });
      await h.runtime.database.transaction(tx => h.runtime.jobs.enqueue(tx, {
        type, payload: {}, dedupeKey: runningKey, replaceExisting: true,
      }));
      const replacementOccurrence = (await state(running.id))!.occurrence_id;
      await expect(h.runtime.jobs.cancel(h.runtime.database.db, { jobId: running.id, occurrenceId: occurrence })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(replacementOccurrence).not.toBe(occurrence);
    } finally {
      await worker.stop().catch(() => undefined);
    }
  });
});
