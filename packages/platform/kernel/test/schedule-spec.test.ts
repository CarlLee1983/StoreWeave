import { describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@storeweave/contracts';
import { RecurringScheduler } from '../src/recurring';
import {
  occurrencesBetween,
  currentOccurrence,
  parseScheduleSpec,
  scheduleOccurrenceKey,
} from '../src/schedule-spec';

const HOUR = 60 * 60 * 1000;

describe('parseScheduleSpec', () => {
  it('接受固定間隔', () => {
    const spec = parseScheduleSpec('cart.cleanup', { everyMs: HOUR });
    expect(spec.kind).toBe('interval');
    expect(spec.catchUp).toBe(1);
    expect(spec.overlap).toBe('queue');
  });

  it('接受 cron 加時區', () => {
    const spec = parseScheduleSpec('report.daily', { cron: '0 0 * * *', timezone: 'Asia/Taipei' });
    expect(spec.kind).toBe('cron');
  });

  it('間隔必須是正數', () => {
    expect(() => parseScheduleSpec('bad', { everyMs: 0 })).toThrow();
    expect(() => parseScheduleSpec('bad', { everyMs: -1 })).toThrow();
    expect(() => parseScheduleSpec('bad', { everyMs: Number.NaN })).toThrow();
  });

  it('非法 cron 運算式在註冊時就被擋下', () => {
    expect(() => parseScheduleSpec('bad', { cron: '0 99 * * *', timezone: 'Asia/Taipei' })).toThrow();
    expect(() => parseScheduleSpec('bad', { cron: '0 0 *', timezone: 'Asia/Taipei' })).toThrow();
  });

  it('未知時區在註冊時就被擋下', () => {
    expect(() => parseScheduleSpec('bad', { cron: '0 0 * * *', timezone: 'Mars/Olympus' })).toThrow();
  });

  it('有歧義的縮寫被擋下，因為 Intl 會照收並解析成猜不到的城市', () => {
    // 實測 Node：CST → America/Chicago、EST → America/Panama
    expect(() => parseScheduleSpec('bad', { cron: '0 0 * * *', timezone: 'CST' })).toThrow(/ambiguous/);
    expect(() => parseScheduleSpec('bad', { cron: '0 0 * * *', timezone: 'EST' })).toThrow(/ambiguous/);
  });

  it('IST 與 BST 被擋下——它們是世界上最歧義的兩個縮寫', () => {
    // 實測 Node：BST → Asia/Dhaka（不是英國夏令，孟加拉還沒有 DST）、IST → Asia/Calcutta
    expect(() => parseScheduleSpec('bad', { cron: '0 2 * * *', timezone: 'BST' })).toThrow(/ambiguous/);
    expect(() => parseScheduleSpec('bad', { cron: '0 2 * * *', timezone: 'IST' })).toThrow(/ambiguous/);
  });

  it('有真實 DST 規則、或只對應一個國家的 legacy 區名照收', () => {
    for (const timezone of ['CET', 'EET', 'WET', 'JST', 'PRC']) {
      expect(() => parseScheduleSpec('ok', { cron: '0 0 * * *', timezone })).not.toThrow();
    }
  });

  it('Etc/GMT±N 被擋下，因為正負號與直覺相反', () => {
    expect(() => parseScheduleSpec('bad', { cron: '0 0 * * *', timezone: 'Etc/GMT+8' })).toThrow(/inverted/);
  });

  it('backward link 是合法的 IANA 識別碼，不該被擋', () => {
    for (const timezone of ['Japan', 'Singapore', 'NZ', 'UTC']) {
      expect(() => parseScheduleSpec('ok', { cron: '0 0 * * *', timezone })).not.toThrow();
    }
  });

  it('cron 一定要指定時區，不隱含用行程的本地時區', () => {
    expect(() => parseScheduleSpec('bad', { cron: '0 0 * * *' } as never)).toThrow();
  });

  it('追補上限必須是正整數', () => {
    expect(() => parseScheduleSpec('bad', { everyMs: HOUR, catchUp: 0 })).toThrow();
    expect(() => parseScheduleSpec('bad', { everyMs: HOUR, catchUp: 1.5 })).toThrow();
    expect(parseScheduleSpec('ok', { everyMs: HOUR, catchUp: 5 }).catchUp).toBe(5);
  });

  it('永遠不會發生的日期組合在註冊時就被擋下', () => {
    // croner 的建構子照收這些，但它們永遠不會到期
    expect(() => parseScheduleSpec('bad', { cron: '0 0 30 2 *', timezone: 'UTC' })).toThrow(/never occurs/);
    expect(() => parseScheduleSpec('bad', { cron: '0 0 31 4 *', timezone: 'UTC' })).toThrow(/never occurs/);
  });

  it('閏日排程是合法的，即使 croner 的回推對它會丟例外', () => {
    const spec = parseScheduleSpec('leap', { cron: '0 0 29 2 *', timezone: 'UTC' });
    expect(spec.kind).toBe('cron');
    // 註冊會兩個方向都探一次；能建起來就代表回推的 fallback 有效
    expect(currentOccurrence(spec, new Date('2026-09-09T00:00:00.000Z'))?.toISOString())
      .toBe('2024-02-29T00:00:00.000Z');
  });

  it('重疊策略只認得 queue 與 skip', () => {
    expect(parseScheduleSpec('ok', { everyMs: HOUR, overlap: 'skip' }).overlap).toBe('skip');
    expect(() => parseScheduleSpec('bad', { everyMs: HOUR, overlap: 'wait' as never })).toThrow();
  });
});

describe('occurrence 身分', () => {
  it('固定間隔沿用切片編號的去重鍵，遷移前後同一個切片是同一個鍵', () => {
    const spec = parseScheduleSpec('cart.cleanup', { everyMs: HOUR });
    const at = new Date('2026-08-22T03:00:00.000Z');
    expect(scheduleOccurrenceKey('cart.cleanup', spec, at)).toBe(
      `recurring:cart.cleanup:${Math.floor(at.getTime() / HOUR)}`,
    );
  });

  it('cron 的去重鍵帶預定執行的絕對時刻，與間隔式不會相撞', () => {
    const spec = parseScheduleSpec('report.daily', { cron: '0 0 * * *', timezone: 'Asia/Taipei' });
    const at = new Date('2026-08-21T16:00:00.000Z');
    expect(scheduleOccurrenceKey('report.daily', spec, at)).toBe(
      'recurring:report.daily:at:1787328000000',
    );
  });
});

describe('currentOccurrence', () => {
  it('間隔式回到切片起點', () => {
    const spec = parseScheduleSpec('t', { everyMs: HOUR });
    expect(currentOccurrence(spec, new Date('2026-08-22T03:17:00.000Z'))?.toISOString())
      .toBe('2026-08-22T03:00:00.000Z');
  });

  it('cron 回到不晚於當下的最近一次預定時刻', () => {
    const spec = parseScheduleSpec('t', { cron: '0 0 * * *', timezone: 'Asia/Taipei' });
    // 台北 2026-08-22 11:17 → 當天午夜是 UTC 08-21 16:00
    expect(currentOccurrence(spec, new Date('2026-08-22T03:17:00.000Z'))?.toISOString())
      .toBe('2026-08-21T16:00:00.000Z');
  });

  it('正好落在預定時刻上時就是那一刻本身', () => {
    const spec = parseScheduleSpec('t', { cron: '0 0 * * *', timezone: 'Asia/Taipei' });
    expect(currentOccurrence(spec, new Date('2026-08-21T16:00:00.000Z'))?.toISOString())
      .toBe('2026-08-21T16:00:00.000Z');
  });
});

describe('occurrencesBetween', () => {
  const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

  it('列出 (after, until] 區間內的每一次', () => {
    const spec = parseScheduleSpec('t', { everyMs: HOUR });
    expect(iso(occurrencesBetween(spec, new Date('2026-08-22T00:00:00.000Z'), new Date('2026-08-22T03:30:00.000Z')))).toEqual([
      '2026-08-22T01:00:00.000Z',
      '2026-08-22T02:00:00.000Z',
      '2026-08-22T03:00:00.000Z',
    ]);
  });

  it('區間內沒有預定時刻就回空', () => {
    const spec = parseScheduleSpec('t', { everyMs: HOUR });
    expect(occurrencesBetween(spec, new Date('2026-08-22T03:00:00.000Z'), new Date('2026-08-22T03:59:00.000Z'))).toEqual([]);
  });

  it('Asia/Taipei 午夜落在 UTC 16:00，不是 UTC 午夜', () => {
    const spec = parseScheduleSpec('t', { cron: '0 0 * * *', timezone: 'Asia/Taipei' });
    expect(iso(occurrencesBetween(spec, new Date('2026-08-20T00:00:00.000Z'), new Date('2026-08-23T00:00:00.000Z')))).toEqual([
      '2026-08-20T16:00:00.000Z',
      '2026-08-21T16:00:00.000Z',
      '2026-08-22T16:00:00.000Z',
    ]);
  });

  it('spring-forward：不存在的當地 02:30 順延到 03:30，當天仍然只有一次', () => {
    const spec = parseScheduleSpec('t', { cron: '30 2 * * *', timezone: 'America/New_York' });
    expect(iso(occurrencesBetween(spec, new Date('2026-03-07T12:00:00.000Z'), new Date('2026-03-10T12:00:00.000Z')))).toEqual([
      '2026-03-08T07:30:00.000Z',
      '2026-03-09T06:30:00.000Z',
      '2026-03-10T06:30:00.000Z',
    ]);
  });

  it('fall-back：重複的當地 01:30 只排一次', () => {
    const spec = parseScheduleSpec('t', { cron: '30 1 * * *', timezone: 'America/New_York' });
    const runs = occurrencesBetween(spec, new Date('2026-11-01T00:00:00.000Z'), new Date('2026-11-02T00:00:00.000Z'));
    expect(iso(runs)).toEqual(['2026-11-01T05:30:00.000Z']);
  });

  it('30 分鐘位移的 DST 時區也算得出來', () => {
    const spec = parseScheduleSpec('t', { cron: '30 2 * * *', timezone: 'Australia/Lord_Howe' });
    expect(iso(occurrencesBetween(spec, new Date('2026-10-03T00:00:00.000Z'), new Date('2026-10-05T00:00:00.000Z')))).toEqual([
      '2026-10-03T15:30:00.000Z',
      '2026-10-04T15:30:00.000Z',
    ]);
  });

  it('列舉有硬上限，避免長期停機後算出無界的清單', () => {
    const spec = parseScheduleSpec('t', { everyMs: 1000 });
    const runs = occurrencesBetween(
      spec,
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-06-01T00:00:00.000Z'),
      10,
    );
    expect(runs).toHaveLength(10);
    // 取的是最靠近 until 的那幾次，不是最舊的那幾次
    expect(runs.at(-1)?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('回推 fallback 的快取不會讓 occurrence 遲到', () => {
  it('同一個 UTC 日內跨過 occurrence 之後，下一輪 tick 就排得出來', () => {
    // croner 對「指定月＋該月不一定存在的日」回推會丟例外，所以這個樣式走正向掃描 fallback。
    // Asia/Taipei 的 2028-02-29 00:00 是 2028-02-28T16:00Z，與 UTC 日界不對齊——按 UTC 日
    // 快取會讓這一次遲到八小時，時區偏移愈大愈久，上界是一整天。
    const spec = parseScheduleSpec('leap', { cron: '0 0 29 2 *', timezone: 'Asia/Taipei' });
    const watermark = new Date('2028-02-28T00:00:00.000Z');

    expect(occurrencesBetween(spec, watermark, new Date('2028-02-28T06:00:00.000Z'))).toEqual([]);
    const after = occurrencesBetween(spec, watermark, new Date('2028-02-28T17:00:00.000Z'));
    expect(after.map((d) => d.toISOString())).toEqual(['2028-02-28T16:00:00.000Z']);
  });
});

describe('單一排程的失敗不會拖垮整輪', () => {
  it('某個排程的交易丟例外時，其他排程照常排入，且 ensureScheduled 不往外丟', async () => {
    const enqueued: string[] = [];
    const scheduler = new RecurringScheduler({
      jobs: { enqueue: async (_tx: never, input: { type: string }) => {
        enqueued.push(input.type);
        return { id: 'x', deduped: false };
      } } as never,
      database: {
        boundedTransaction: async (_ms: number, operation: string, fn: (tx: never) => Promise<unknown>) => {
          if (operation.includes('broken')) throw new Error('deadlock detected');
          // 假的排程狀態列：watermark 落後一小時，所以剛好有一次到期
          const row = {
            type: 'x', fingerprint: 'interval:3600000', paused: false, paused_at: null,
            last_occurrence_at: new Date('2026-01-05T02:00:00.000Z'),
            last_enqueued_at: null, skipped_count: 0,
          };
          const tx = { execute: async () => ({ rows: [row] }) };
          return fn(tx as never);
        },
      } as never,
      logger: noopLogger,
    });
    scheduler.register('broken', { everyMs: HOUR });
    scheduler.register('healthy', { everyMs: HOUR });

    const result = await scheduler.ensureScheduled(new Date('2026-01-05T03:10:00.000Z'));

    expect(enqueued).toEqual(['healthy']);
    expect(result.enqueued).toBe(1);
    // 失敗必須被算進去：只記 log 而不計數，一個從週五開始每輪逾時的排程沒有人會發現
    expect(result.failed).toBe(1);
  });

  it('連續失敗會從 warn 升級成 error，成功後歸零', async () => {
    const levels: string[] = [];
    const logger = {
      ...noopLogger,
      warn: (..._args: unknown[]) => { levels.push('warn'); },
      error: (..._args: unknown[]) => { levels.push('error'); },
    };
    let broken = true;
    const scheduler = new RecurringScheduler({
      jobs: { enqueue: async () => ({ id: 'x', deduped: false }) } as never,
      database: {
        boundedTransaction: async (_ms: number, _op: string, fn: (tx: never) => Promise<unknown>) => {
          if (broken) throw new Error('deadlock detected');
          const row = {
            type: 'x', fingerprint: 'interval:3600000', paused: false, paused_at: null,
            last_occurrence_at: new Date('2026-01-05T02:00:00.000Z'),
            last_enqueued_at: null, skipped_catchup: 0, skipped_paused: 0, skipped_overlap: 0,
            consecutive_overlap_skips: 0,
          };
          return fn({ execute: async () => ({ rows: [row] }) } as never);
        },
      } as never,
      logger: logger as never,
    });
    scheduler.register('flaky', { everyMs: HOUR });

    const at = new Date('2026-01-05T03:10:00.000Z');
    for (let i = 0; i < 3; i += 1) await scheduler.ensureScheduled(at);
    expect(levels).toEqual(['warn', 'warn', 'error']);

    broken = false;
    await scheduler.ensureScheduled(at);
    broken = true;
    await scheduler.ensureScheduled(at);
    expect(levels.at(-1)).toBe('warn');
  });
});

describe('排程階段的預算不會餓死順序靠後的排程', () => {
  /** 假的排程狀態列：watermark 落後一小時，所以每個排程剛好有一次到期。 */
  const dueRow = () => ({
    type: 'x', fingerprint: 'interval:3600000', paused: false, paused_at: null,
    last_occurrence_at: new Date('2026-01-05T02:00:00.000Z'),
    last_enqueued_at: null, skipped_catchup: 0, skipped_paused: 0, skipped_overlap: 0,
    consecutive_overlap_skips: 0,
  });

  it('第一個排程每輪吃光預算時，後面的排程仍然輪得到', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T03:10:00.000Z'));
    try {
      const enqueued: string[] = [];
      const scheduler = new RecurringScheduler({
        jobs: { enqueue: async (_tx: never, input: { type: string }) => {
          enqueued.push(input.type);
          return { id: 'x', deduped: false };
        } } as never,
        database: {
          boundedTransaction: async (_ms: number, operation: string, fn: (tx: never) => Promise<unknown>) => {
            if (operation.includes('slow')) {
              // 這一個排程把整份預算耗光才逾時——不需要有 bug，列鎖久等就會這樣。
              vi.advanceTimersByTime(6000);
              throw new Error('statement timeout');
            }
            return fn({ execute: async () => ({ rows: [dueRow()] }) } as never);
          },
        } as never,
        logger: noopLogger,
      });
      scheduler.register('slow', { everyMs: HOUR });
      scheduler.register('later-a', { everyMs: HOUR });
      scheduler.register('later-b', { everyMs: HOUR });

      const at = new Date('2026-01-05T03:10:00.000Z');
      for (let i = 0; i < 3; i += 1) await scheduler.ensureScheduled(at);

      // 起點固定時 later-a／later-b 一次都排不到，而 failed 恆為 1，看起來只像偶爾抖動。
      expect(new Set(enqueued)).toEqual(new Set(['later-a', 'later-b']));
    } finally {
      vi.useRealTimers();
    }
  });
});
