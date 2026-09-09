import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { createHarness, type TestHarness } from './helpers';

/**
 * 排程器跑在真的資料庫上（B05 第三、四片）。
 *
 * 時間全部是注入的：`ensureScheduled(now)` 收一個時刻，所以 DST、停機追補與暫停
 * 都不需要等真實時鐘。排程只負責 enqueue；「有沒有真的跑」由既有的 worker 測試涵蓋。
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const intervalPayload = z.object({ bucket: z.number().int(), scheduledFor: z.string().datetime() }).strict();
const cronPayload = z.object({ scheduledFor: z.string().datetime() }).strict();

let seq = 0;
function registerSchedule(schedule: Parameters<typeof h.runtime.recurring.register>[1], cron = false) {
  const type = `test.schedule.${seq += 1}`;
  h.runtime.jobRegistry.register(type, vi.fn(async () => {}), 'test', {
    currentVersion: 1,
    versions: { 1: cron ? cronPayload : intervalPayload },
  });
  h.runtime.recurring.register(type, schedule);
  return type;
}

async function scheduledRunAts(type: string): Promise<string[]> {
  const res = await h.runtime.database.db.execute<{ run_at: Date; dedupe_key: string }>(sql`
    SELECT run_at, dedupe_key FROM platform_jobs WHERE type = ${type} ORDER BY run_at
  `);
  return res.rows.map((row) => new Date(row.run_at).toISOString());
}

async function dedupeKeys(type: string): Promise<string[]> {
  const res = await h.runtime.database.db.execute<{ dedupe_key: string }>(sql`
    SELECT dedupe_key FROM platform_jobs WHERE type = ${type} ORDER BY run_at
  `);
  return res.rows.map((row) => row.dedupe_key);
}

async function scheduleRow(type: string) {
  const res = await h.runtime.database.db.execute<{
    paused: boolean; last_occurrence_at: Date | null;
    skipped_catchup: string; skipped_paused: string; skipped_overlap: string;
    consecutive_overlap_skips: number;
  }>(sql`SELECT paused, last_occurrence_at, skipped_catchup, skipped_paused, skipped_overlap,
           consecutive_overlap_skips FROM platform_job_schedules WHERE type = ${type}`);
  return res.rows[0];
}

describe('冷啟動與固定間隔（ADR 0016 行為保留）', () => {
  it('第一次確保就把「當下這一次」排進去，不是等到下一個切片', async () => {
    const type = registerSchedule({ everyMs: HOUR });
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T03:17:00.000Z'));
    expect(await scheduledRunAts(type)).toEqual(['2026-01-05T03:00:00.000Z']);
  });

  it('間隔式的去重鍵仍然是 recurring:<type>:<bucket>，遷移前後同一個切片是同一個鍵', async () => {
    const type = registerSchedule({ everyMs: HOUR });
    const at = new Date('2026-01-05T03:17:00.000Z');
    await h.runtime.recurring.ensureScheduled(at);
    expect(await dedupeKeys(type)).toEqual([`recurring:${type}:${Math.floor(Date.parse('2026-01-05T03:00:00Z') / HOUR)}`]);
  });

  it('同一個切片內重複確保不會排第二次', async () => {
    const type = registerSchedule({ everyMs: HOUR });
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T03:00:00.000Z'));
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T03:30:00.000Z'));
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T03:59:59.999Z'));
    expect(await scheduledRunAts(type)).toHaveLength(1);
  });

  it('連續數個切片各排一次', async () => {
    const type = registerSchedule({ everyMs: HOUR });
    for (let i = 0; i < 4; i += 1) {
      await h.runtime.recurring.ensureScheduled(new Date(Date.parse('2026-01-05T00:30:00Z') + i * HOUR));
    }
    expect(await scheduledRunAts(type)).toEqual([
      '2026-01-05T00:00:00.000Z', '2026-01-05T01:00:00.000Z',
      '2026-01-05T02:00:00.000Z', '2026-01-05T03:00:00.000Z',
    ]);
  });

  it('間隔式 payload 仍帶 bucket，既有 v1 strict schema 不會把它擋成 quarantine', async () => {
    const type = registerSchedule({ everyMs: HOUR });
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T03:17:00.000Z'));
    const res = await h.runtime.database.db.execute<{ payload: { bucket: number; scheduledFor: string } }>(sql`
      SELECT payload FROM platform_jobs WHERE type = ${type}
    `);
    expect(intervalPayload.safeParse(res.rows[0].payload).success).toBe(true);
  });
});

describe('冷啟動的陳舊界限', () => {
  it('第一次見到稀疏排程時不補一次陳年的 occurrence', async () => {
    // 閏日排程在 2026 年第一次部署：「當下這一次」是 2024-02-29。補下去等於立刻跑一次
    // 兩年半前的作業，而 handler 多半照 scheduledFor 決定資料區間。
    const type = registerSchedule({ cron: '0 0 29 2 *', timezone: 'UTC' }, true);
    const result = await h.runtime.recurring.ensureScheduled(new Date('2026-09-09T00:00:00.000Z'));

    expect(await scheduledRunAts(type)).toEqual([]);
    expect(result.failed).toBe(0);
    // watermark 仍然前進，所以下一個真正的 occurrence 會照常排
    expect((await scheduleRow(type)).last_occurrence_at).not.toBeNull();
  });

  it('週期在界限內的排程，冷啟動照樣補當下這一次（ADR 0016 行為保留）', async () => {
    const type = registerSchedule({ cron: '0 0 * * *', timezone: 'UTC' }, true);
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T12:00:00.000Z'));
    expect(await scheduledRunAts(type)).toEqual(['2026-01-05T00:00:00.000Z']);
  });
});

describe('cron 與時區', () => {
  it('Asia/Taipei 午夜排在 UTC 16:00', async () => {
    const type = registerSchedule({ cron: '0 0 * * *', timezone: 'Asia/Taipei' }, true);
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T03:00:00.000Z'));
    expect(await scheduledRunAts(type)).toEqual(['2026-01-04T16:00:00.000Z']);
  });

  it('cron 的去重鍵帶絕對時刻，與間隔式不會相撞', async () => {
    const type = registerSchedule({ cron: '0 0 * * *', timezone: 'Asia/Taipei' }, true);
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T03:00:00.000Z'));
    expect(await dedupeKeys(type)).toEqual([`recurring:${type}:at:${Date.parse('2026-01-04T16:00:00Z')}`]);
  });

  it('spring-forward 當天：不存在的 02:30 順延，一天仍然只有一次', async () => {
    const type = registerSchedule({ cron: '30 2 * * *', timezone: 'America/New_York', catchUp: 10 }, true);
    await h.runtime.recurring.ensureScheduled(new Date('2026-03-07T12:00:00.000Z'));
    await h.runtime.recurring.ensureScheduled(new Date('2026-03-10T12:00:00.000Z'));
    expect(await scheduledRunAts(type)).toEqual([
      '2026-03-07T07:30:00.000Z',
      '2026-03-08T07:30:00.000Z',
      '2026-03-09T06:30:00.000Z',
      '2026-03-10T06:30:00.000Z',
    ]);
  });

  it('fall-back 當天：重複的 01:30 只排一次', async () => {
    const type = registerSchedule({ cron: '30 1 * * *', timezone: 'America/New_York', catchUp: 10 }, true);
    await h.runtime.recurring.ensureScheduled(new Date('2026-11-01T00:00:00.000Z'));
    await h.runtime.recurring.ensureScheduled(new Date('2026-11-02T12:00:00.000Z'));
    // 冷啟動先補當下這一次（10-31），重點是 11-01 的 01:30 只出現一次而不是兩次
    expect(await scheduledRunAts(type)).toEqual([
      '2026-10-31T05:30:00.000Z',
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
    ]);
  });
});

describe('停機追補', () => {
  it('預設只補最近的那一次，中間跨過的算 skipped', async () => {
    const type = registerSchedule({ everyMs: HOUR });
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T00:10:00.000Z'));
    const result = await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T05:10:00.000Z'));

    expect(await scheduledRunAts(type)).toEqual(['2026-01-05T00:00:00.000Z', '2026-01-05T05:00:00.000Z']);
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
    expect(Number((await scheduleRow(type)).skipped_catchup)).toBe(4);
  });

  it('catchUp 指定幾次就補幾次，且補的是最近的那幾次', async () => {
    const type = registerSchedule({ everyMs: HOUR, catchUp: 3 });
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T00:10:00.000Z'));
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T05:10:00.000Z'));

    expect(await scheduledRunAts(type)).toEqual([
      '2026-01-05T00:00:00.000Z',
      '2026-01-05T03:00:00.000Z',
      '2026-01-05T04:00:00.000Z',
      '2026-01-05T05:00:00.000Z',
    ]);
    expect(Number((await scheduleRow(type)).skipped_catchup)).toBe(2);
  });
});

describe('暫停與恢復', () => {
  it('暫停後不再排入，恢復後從當下這一次繼續，不補暫停期間的積壓', async () => {
    const type = registerSchedule({ everyMs: HOUR });
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T00:10:00.000Z'));

    await h.runtime.database.transaction((tx) => h.runtime.recurring.setPaused(tx, type, true));
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T01:10:00.000Z'));
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T02:10:00.000Z'));
    expect(await scheduledRunAts(type)).toEqual(['2026-01-05T00:00:00.000Z']);

    await h.runtime.database.transaction((tx) => h.runtime.recurring.setPaused(tx, type, false));
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T03:10:00.000Z'));
    expect(await scheduledRunAts(type)).toEqual(['2026-01-05T00:00:00.000Z', '2026-01-05T03:00:00.000Z']);
  });

  it('暫停立即生效，不必等到下一個切片才被看見', async () => {
    const type = registerSchedule({ everyMs: HOUR });
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T00:10:00.000Z'));
    await h.runtime.database.transaction((tx) => h.runtime.recurring.setPaused(tx, type, true));
    expect((await scheduleRow(type)).paused).toBe(true);
    const result = await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T01:10:00.000Z'));
    expect(result.enqueued).toBe(0);
  });

  it('暫停中的排程不顯示下一次執行時間', async () => {
    const type = registerSchedule({ everyMs: HOUR });
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T00:10:00.000Z'));
    const before = (await h.runtime.recurring.list(h.runtime.database.db)).find((s) => s.type === type);
    expect(before?.nextOccurrenceAt).not.toBeNull();

    await h.runtime.database.transaction((tx) => h.runtime.recurring.setPaused(tx, type, true));
    const after = (await h.runtime.recurring.list(h.runtime.database.db)).find((s) => s.type === type);
    expect(after?.paused).toBe(true);
    expect(after?.nextOccurrenceAt).toBeNull();
  });

  it('未註冊的型別不能被暫停', async () => {
    await expect(
      h.runtime.database.transaction((tx) => h.runtime.recurring.setPaused(tx, 'test.schedule.missing', true)),
    ).rejects.toThrow();
  });
});

describe('重疊策略', () => {
  it('overlap=skip 時上一次還沒跑完就不排新的', async () => {
    const type = registerSchedule({ everyMs: HOUR, overlap: 'skip' });
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T00:10:00.000Z'));
    expect(await scheduledRunAts(type)).toHaveLength(1);

    // 前一次仍是 pending，第二個切片不該再排
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T01:10:00.000Z'));
    expect(await scheduledRunAts(type)).toHaveLength(1);
    const row = await scheduleRow(type);
    expect(Number(row.skipped_overlap)).toBe(1);
    expect(Number(row.skipped_catchup)).toBe(0);
    expect(row.consecutive_overlap_skips).toBe(1);
  });

  it('overlap=skip 不會被自己剛排好、還沒到期的那一筆擋住', async () => {
    const type = registerSchedule({ everyMs: HOUR, overlap: 'skip' });
    // 第一次確保時 occurrence 的 run_at 就是切片起點（過去），所以它是「已到期」的；
    // 這裡驗的是判準看的是 run_at 而不是單純的 pending。
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T00:10:00.000Z'));
    const [row] = (await h.runtime.database.db.execute<{ run_at: Date }>(
      sql`SELECT run_at FROM platform_jobs WHERE type = ${type}`,
    )).rows;
    expect(new Date(row.run_at).toISOString()).toBe('2026-01-05T00:00:00.000Z');
  });

  it('overlap=skip 把重試退避中的工作算成重疊，即使它的 run_at 在未來', async () => {
    const type = registerSchedule({ everyMs: HOUR, overlap: 'skip' });
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T00:10:00.000Z'));

    // 模擬一次失敗後的退避：仍是 pending，但 run_at 被推到未來。退避上限 600 秒，
    // 對週期短的排程來說只看 run_at 會讓失敗中的工作被當成不存在而愈堆愈多。
    await h.runtime.database.db.execute(sql`
      UPDATE platform_jobs SET attempts = 1, run_at = now() + interval '10 minutes'
      WHERE type = ${type}
    `);

    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T01:10:00.000Z'));
    expect(await scheduledRunAts(type)).toHaveLength(1);
    expect(Number((await scheduleRow(type)).skipped_overlap)).toBe(1);
  });

  it('連續被 overlap 擋下會累積計數，排入後歸零', async () => {
    const type = registerSchedule({ everyMs: HOUR, overlap: 'skip' });
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T00:10:00.000Z'));
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T01:10:00.000Z'));
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T02:10:00.000Z'));
    expect((await scheduleRow(type)).consecutive_overlap_skips).toBe(2);

    // 把卡住的那一筆做掉，下一輪就會恢復排入並把連續計數歸零
    await h.runtime.database.db.execute(
      sql`UPDATE platform_jobs SET status = 'completed' WHERE type = ${type}`,
    );
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T03:10:00.000Z'));
    expect((await scheduleRow(type)).consecutive_overlap_skips).toBe(0);
  });

  it('overlap=queue（預設）時照排不誤', async () => {
    const type = registerSchedule({ everyMs: HOUR });
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T00:10:00.000Z'));
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T01:10:00.000Z'));
    expect(await scheduledRunAts(type)).toHaveLength(2);
  });
});

describe('多 worker 競爭', () => {
  it('排程狀態列的寫鎖真的擋住第二個 worker，不是只靠去重鍵', async () => {
    const type = registerSchedule({ everyMs: HOUR });
    // 先建立狀態列，才有列可以鎖
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T00:10:00.000Z'));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = h.runtime.database.transaction(async (tx) => {
      await tx.execute(sql`SELECT type FROM platform_job_schedules WHERE type = ${type} FOR UPDATE`);
      await gate;
    });

    let settled = false;
    const blocked = h.runtime.recurring
      .ensureScheduled(new Date('2026-01-05T01:10:00.000Z'))
      .then((result) => { settled = true; return result; });

    await new Promise((resolve) => setTimeout(resolve, 500));
    // 這時第二個切片已經到期，但鎖還在別人手上，所以什麼都排不進去
    expect(settled).toBe(false);
    expect(await scheduledRunAts(type)).toHaveLength(1);

    release();
    await holder;
    await blocked;
    expect(settled).toBe(true);
    expect(await scheduledRunAts(type)).toEqual(['2026-01-05T00:00:00.000Z', '2026-01-05T01:00:00.000Z']);
  });


  it('兩個排程器同時補同一個切片，只留下一筆', async () => {
    const type = registerSchedule({ everyMs: HOUR });
    const at = new Date('2026-01-05T03:10:00.000Z');
    // 兩邊都會跑過所有已註冊的排程，所以回傳的 enqueued 不只算這個 type，
    // 誰先誰後也不保證。判準只有一個：這個 type 只留下一筆，watermark 只前進到那一次。
    // 「是列鎖擋下的、不是只靠去重鍵」由上一條測試單獨證明。
    await Promise.all([
      h.runtime.recurring.ensureScheduled(at),
      h.runtime.recurring.ensureScheduled(at),
    ]);
    expect(await scheduledRunAts(type)).toEqual(['2026-01-05T03:00:00.000Z']);
    expect(Number((await scheduleRow(type)).skipped_catchup)).toBe(0);
  });
});

describe('宣告變更', () => {
  it('改了排程宣告之後不重放舊的時間表', async () => {
    const type = `test.schedule.changed`;
    h.runtime.jobRegistry.register(type, vi.fn(async () => {}), 'test', {
      currentVersion: 1, versions: { 1: intervalPayload },
    });
    h.runtime.recurring.register(type, { everyMs: DAY });
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-01T12:00:00.000Z'));
    const before = await scheduledRunAts(type);

    // 換一個排程器實例代表新版程式碼上線，宣告從一天改成一小時
    const restarted = new (h.runtime.recurring.constructor as typeof import('@storeweave/kernel').RecurringScheduler)({
      jobs: h.runtime.jobs, database: h.runtime.database, logger: h.runtime.logger,
    });
    restarted.register(type, { everyMs: HOUR });
    await restarted.ensureScheduled(new Date('2026-01-05T03:10:00.000Z'));

    const after = await scheduledRunAts(type);
    // 只多了新宣告的當下這一次，中間四天沒有被重放
    expect(after.length).toBe(before.length + 1);
    expect(after.at(-1)).toBe('2026-01-05T03:00:00.000Z');
  });

  it('稀疏排程改了宣告之後從下一次開始，不補一次陳年的 occurrence', async () => {
    // 宣告變更走的是冷啟動分支，所以七天陳舊界限一併適用：改一個月排程的運算式，
    // 被重設的「當下這一次」若已經過了七天以上就不補，最久要等一個月才第一次跑。
    const type = 'test.schedule.changed.sparse';
    h.runtime.jobRegistry.register(type, vi.fn(async () => {}), 'test', {
      currentVersion: 1, versions: { 1: cronPayload },
    });
    h.runtime.recurring.register(type, { cron: '0 0 1 * *', timezone: 'UTC' });
    await h.runtime.recurring.ensureScheduled(new Date('2026-03-01T00:30:00.000Z'));
    expect(await scheduledRunAts(type)).toEqual(['2026-03-01T00:00:00.000Z']);

    const restarted = new (h.runtime.recurring.constructor as typeof import('@storeweave/kernel').RecurringScheduler)({
      jobs: h.runtime.jobs, database: h.runtime.database, logger: h.runtime.logger,
    });
    restarted.register(type, { cron: '0 12 1 * *', timezone: 'UTC' });
    // 新宣告的「當下這一次」是 3/1 12:00，距離現在已經三週
    const result = await restarted.ensureScheduled(new Date('2026-03-22T00:00:00.000Z'));

    expect(await scheduledRunAts(type)).toEqual(['2026-03-01T00:00:00.000Z']);
    expect(result.enqueued).toBe(0);
    // watermark 仍然前進，4/1 12:00 會照常排
    expect((await scheduleRow(type)).last_occurrence_at).not.toBeNull();
  });
});

describe('setPaused 的惰性 anchor', () => {
  it('列已經存在時不重算 anchor，watermark 原封不動', async () => {
    const type = registerSchedule({ everyMs: HOUR });
    await h.runtime.recurring.ensureScheduled(new Date('2026-01-05T00:10:00.000Z'));
    const before = (await scheduleRow(type)).last_occurrence_at;
    expect(before).not.toBeNull();

    await h.runtime.database.transaction((tx) => h.runtime.recurring.setPaused(tx, type, true));
    await h.runtime.database.transaction((tx) => h.runtime.recurring.setPaused(tx, type, false));

    const after = (await scheduleRow(type)).last_occurrence_at;
    expect(new Date(after!).toISOString()).toBe(new Date(before!).toISOString());
  });

  it('列還不存在時就地建立並帶上 anchor，恢復後不會湧出整段積壓', async () => {
    const type = registerSchedule({ everyMs: HOUR });
    const now = new Date('2026-01-05T03:10:00.000Z');
    await h.runtime.database.transaction((tx) => h.runtime.recurring.setPaused(tx, type, true, now));

    const row = await scheduleRow(type);
    expect(row.paused).toBe(true);
    // anchor 是「當下這一次的前一次」，不是 epoch——否則恢復時會補上幾十年的積壓
    expect(new Date(row.last_occurrence_at!).toISOString()).toBe('2026-01-05T02:00:00.000Z');

    await h.runtime.database.transaction((tx) => h.runtime.recurring.setPaused(tx, type, false, now));
    await h.runtime.recurring.ensureScheduled(now);
    expect(await scheduledRunAts(type)).toEqual(['2026-01-05T03:00:00.000Z']);
  });
});
