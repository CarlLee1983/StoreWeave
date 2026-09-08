import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PermanentJobError } from '@storeweave/jobs';
import { occurrenceKeyFor, bucketFor } from '@storeweave/kernel';
import { z } from 'zod';
import { createHarness, type TestHarness } from './helpers';

/**
 * 週期性工作跑在真的資料庫上（工單 03）。
 * 時間是注入的：ensureScheduled 收一個時刻，因此不需要等待也不依賴真實時鐘。
 */

const HOUR = 60 * 60 * 1000;
// 固定在過去，確保切片起點一定小於資料庫的 now()，工作立刻可被認領
const T0 = new Date('2026-01-05T03:20:00.000Z');
const recurringPayload = z.object({ bucket: z.number().int(), scheduledFor: z.string().datetime() }).strict();

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

/**
 * 把佇列裡的工作跑完。
 *
 * 不能用 `worker.drain()`：它每一輪都會 `ensureScheduled(now)`，於是又排進
 * 當下切片的那一次，讓「跑了幾次」變成另一個問題。一輪 `runJobs` 又只認領
 * concurrency 筆，而這個資料庫裡還有其他模組宣告的週期性工作。
 */
async function runQueuedJobs(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await h.worker.runJobs();
    // 失敗的工作要讓測試紅，不是當成「還有事做」繼續轉——這個檔案裡
    // 只有明確宣告會失敗的那條測試會踩到它，而它用的是自己的工作型別。
    if (result.failed > 0) return;
    if (result.processed === 0) return;
  }
}

async function jobRows(type: string) {
  const res = await h.runtime.database.db.execute<{ dedupe_key: string; status: string; attempts: number }>(sql`
    SELECT dedupe_key, status, attempts FROM platform_jobs WHERE type = ${type} ORDER BY dedupe_key
  `);
  return res.rows;
}

describe('週期性工作', () => {
  it('確保當下切片後，工作會被執行；同一個切片不會再排第二次', async () => {
    const handler = vi.fn(async () => {});
    h.runtime.jobRegistry.register('test.recurring.basic', handler, 'test', { currentVersion: 1, versions: { 1: recurringPayload } });
    h.runtime.recurring.register({ type: 'test.recurring.basic', everyMs: HOUR });

    await h.runtime.recurring.ensureScheduled(T0);
    // 一輪只認領 concurrency 筆，而這個資料庫裡還有其他模組宣告的週期性工作。
    await runQueuedJobs();
    expect(handler).toHaveBeenCalledTimes(1);

    // 同一個切片內再確保幾次，都不該產生新的工作
    await h.runtime.recurring.ensureScheduled(new Date(T0.getTime() + 60_000));
    await h.runtime.recurring.ensureScheduled(new Date(T0.getTime() + 39 * 60_000));
    await runQueuedJobs();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(await jobRows('test.recurring.basic')).toHaveLength(1);
  });

  it('進到下一個切片會排入新的一次，去重鍵不同', async () => {
    await h.runtime.recurring.ensureScheduled(new Date(T0.getTime() + HOUR));
    await runQueuedJobs();

    const rows = await jobRows('test.recurring.basic');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'completed')).toBe(true);
    expect(new Set(rows.map((r) => r.dedupe_key)).size).toBe(2);
    expect(rows.map((r) => r.dedupe_key)).toContain(
      occurrenceKeyFor('test.recurring.basic', bucketFor(T0, HOUR)),
    );
  });

  it('連續數個切片各跑一次', async () => {
    const handler = vi.fn(async () => {});
    h.runtime.jobRegistry.register('test.recurring.many', handler, 'test', { currentVersion: 1, versions: { 1: recurringPayload } });
    h.runtime.recurring.register({ type: 'test.recurring.many', everyMs: HOUR });

    for (let i = 0; i < 4; i += 1) {
      await h.runtime.recurring.ensureScheduled(new Date(T0.getTime() + i * HOUR));
      await runQueuedJobs();
    }

    expect(handler).toHaveBeenCalledTimes(4);
    expect(await jobRows('test.recurring.many')).toHaveLength(4);
  });

  it('某一次進了死信不會讓後續的切片停擺', async () => {
    const handler = vi.fn(async () => { throw new PermanentJobError('故意失敗'); });
    h.runtime.jobRegistry.register('test.recurring.dead', handler, 'test', { currentVersion: 1, versions: { 1: recurringPayload } });
    h.runtime.recurring.register({ type: 'test.recurring.dead', everyMs: HOUR });

    await h.runtime.recurring.ensureScheduled(T0);
    await h.worker.runJobs();

    const afterFirst = await jobRows('test.recurring.dead');
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].status).toBe('dead');

    // 鏈斷了也沒關係 —— 下一個切片由 Worker 自己補上
    await h.runtime.recurring.ensureScheduled(new Date(T0.getTime() + HOUR));
    await h.worker.runJobs();

    const afterSecond = await jobRows('test.recurring.dead');
    expect(afterSecond).toHaveLength(2);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('worker tick 會自己確保週期性工作已排入', async () => {
    const handler = vi.fn(async () => {});
    h.runtime.jobRegistry.register('test.recurring.tick', handler, 'test', { currentVersion: 1, versions: { 1: recurringPayload } });
    h.runtime.recurring.register({ type: 'test.recurring.tick', everyMs: HOUR });

    const first = await h.worker.tick();
    expect(first.recurringScheduled).toBeGreaterThanOrEqual(1);
    // 一輪 tick 只認領 concurrency 筆，而這個資料庫裡還有其他模組宣告的週期性工作
    // （例如訪客購物車清理）。把剩下的跑完再斷言，否則這條測試會被排隊順序左右。
    await h.worker.runJobs();
    expect(handler).toHaveBeenCalledTimes(1);

    const second = await h.worker.tick();
    expect(second.recurringScheduled).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
