import { describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@storeweave/contracts';
import { RecurringScheduler, bucketFor, occurrenceKeyFor, occurrenceRunAt } from '../src/recurring';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function fakeDeps() {
  const enqueued: { type: string; dedupeKey?: string; runAt?: Date; payload: unknown }[] = [];
  const seenKeys = new Set<string>();
  const jobs = {
    enqueue: vi.fn(async (_tx: unknown, input: any) => {
      if (input.dedupeKey && seenKeys.has(input.dedupeKey)) return { id: 'x', deduped: true };
      if (input.dedupeKey) seenKeys.add(input.dedupeKey);
      enqueued.push(input);
      return { id: `job-${enqueued.length}`, deduped: false };
    }),
  };
  const database = { transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn({}) };
  return { enqueued, jobs, database, logger: noopLogger };
}

describe('週期切片', () => {
  it('同一個週期內的任何時刻都落在同一個切片', () => {
    const everyMs = HOUR;
    expect(bucketFor(new Date('2026-08-22T03:00:00.000Z'), everyMs))
      .toBe(bucketFor(new Date('2026-08-22T03:59:59.999Z'), everyMs));
  });

  it('跨過週期邊界就換一個切片', () => {
    const everyMs = HOUR;
    const before = bucketFor(new Date('2026-08-22T03:59:59.999Z'), everyMs);
    const after = bucketFor(new Date('2026-08-22T04:00:00.000Z'), everyMs);
    expect(after).toBe(before + 1);
  });

  it('去重鍵帶著切片編號，因此每個週期都是新的鍵', () => {
    const a = occurrenceKeyFor('cart.cleanup', 100);
    const b = occurrenceKeyFor('cart.cleanup', 101);
    expect(a).not.toBe(b);
    expect(a).toContain('cart.cleanup');
  });

  it('切片的執行時間對齊週期邊界', () => {
    expect(occurrenceRunAt(bucketFor(new Date('2026-08-22T03:17:00.000Z'), HOUR), HOUR).toISOString())
      .toBe('2026-08-22T03:00:00.000Z');
  });
});

describe('RecurringScheduler', () => {
  it('第一次確保時把當下這個週期排進去', async () => {
    const deps = fakeDeps();
    const scheduler = new RecurringScheduler(deps as never);
    scheduler.register({ type: 'cart.cleanup', everyMs: HOUR });

    const result = await scheduler.ensureScheduled(new Date('2026-08-22T03:17:00.000Z'));

    expect(result.enqueued).toBe(1);
    expect(deps.enqueued).toHaveLength(1);
    expect(deps.enqueued[0].type).toBe('cart.cleanup');
    expect(deps.enqueued[0].runAt?.toISOString()).toBe('2026-08-22T03:00:00.000Z');
  });

  it('同一個週期內重複確保不會重複排入', async () => {
    const deps = fakeDeps();
    const scheduler = new RecurringScheduler(deps as never);
    scheduler.register({ type: 'cart.cleanup', everyMs: HOUR });

    await scheduler.ensureScheduled(new Date('2026-08-22T03:00:00.000Z'));
    await scheduler.ensureScheduled(new Date('2026-08-22T03:00:00.001Z'));
    await scheduler.ensureScheduled(new Date('2026-08-22T03:59:59.999Z'));

    expect(deps.enqueued).toHaveLength(1);
  });

  it('連續數個週期各排入一次，去重鍵每次都不同', async () => {
    const deps = fakeDeps();
    const scheduler = new RecurringScheduler(deps as never);
    scheduler.register({ type: 'tier.recalculate', everyMs: HOUR });

    const start = Date.parse('2026-08-22T00:30:00.000Z');
    for (let i = 0; i < 5; i += 1) {
      await scheduler.ensureScheduled(new Date(start + i * HOUR));
    }

    expect(deps.enqueued).toHaveLength(5);
    const keys = deps.enqueued.map((e) => e.dedupeKey);
    expect(new Set(keys).size).toBe(5);
    expect(deps.enqueued.map((e) => e.runAt?.toISOString())).toEqual([
      '2026-08-22T00:00:00.000Z',
      '2026-08-22T01:00:00.000Z',
      '2026-08-22T02:00:00.000Z',
      '2026-08-22T03:00:00.000Z',
      '2026-08-22T04:00:00.000Z',
    ]);
  });

  it('停機跨過數個週期後只補排當下這一個，不追補過去的', async () => {
    const deps = fakeDeps();
    const scheduler = new RecurringScheduler(deps as never);
    scheduler.register({ type: 'tier.recalculate', everyMs: HOUR });

    await scheduler.ensureScheduled(new Date('2026-08-22T00:10:00.000Z'));
    await scheduler.ensureScheduled(new Date('2026-08-22T05:10:00.000Z'));

    expect(deps.enqueued.map((e) => e.runAt?.toISOString())).toEqual([
      '2026-08-22T00:00:00.000Z',
      '2026-08-22T05:00:00.000Z',
    ]);
  });

  it('多個週期性工作各自獨立', async () => {
    const deps = fakeDeps();
    const scheduler = new RecurringScheduler(deps as never);
    scheduler.register({ type: 'cart.cleanup', everyMs: HOUR });
    scheduler.register({ type: 'points.expiryNotice', everyMs: 24 * HOUR });

    await scheduler.ensureScheduled(new Date('2026-08-22T03:00:00.000Z'));
    await scheduler.ensureScheduled(new Date('2026-08-22T04:00:00.000Z'));

    const byType = deps.enqueued.reduce<Record<string, number>>((acc, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + 1;
      return acc;
    }, {});
    expect(byType).toEqual({ 'cart.cleanup': 2, 'points.expiryNotice': 1 });
  });

  it('另一個行程已經排過同一個切片時視為已排入，不算重複', async () => {
    const deps = fakeDeps();
    const scheduler = new RecurringScheduler(deps as never);
    scheduler.register({ type: 'cart.cleanup', everyMs: HOUR });

    // 先由「另一個行程」佔走這個切片的去重鍵
    const bucket = bucketFor(new Date('2026-08-22T03:10:00.000Z'), HOUR);
    await deps.jobs.enqueue({}, { type: 'cart.cleanup', payload: {}, dedupeKey: occurrenceKeyFor('cart.cleanup', bucket) });
    deps.enqueued.length = 0;

    const result = await scheduler.ensureScheduled(new Date('2026-08-22T03:10:00.000Z'));

    expect(result.enqueued).toBe(0);
    expect(deps.enqueued).toHaveLength(0);
  });

  it('註冊同一個 type 兩次會被擋下來', () => {
    const scheduler = new RecurringScheduler(fakeDeps() as never);
    scheduler.register({ type: 'cart.cleanup', everyMs: HOUR });
    expect(() => scheduler.register({ type: 'cart.cleanup', everyMs: HOUR })).toThrow();
  });

  it('週期必須是正數', () => {
    const scheduler = new RecurringScheduler(fakeDeps() as never);
    expect(() => scheduler.register({ type: 'bad', everyMs: 0 })).toThrow();
    expect(() => scheduler.register({ type: 'bad', everyMs: -1 })).toThrow();
  });

  it('沒有註冊任何工作時不碰資料庫', async () => {
    const deps = fakeDeps();
    const scheduler = new RecurringScheduler(deps as never);
    const result = await scheduler.ensureScheduled(new Date());
    expect(result.enqueued).toBe(0);
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
  });
});
