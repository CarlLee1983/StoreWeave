import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformError, type Logger } from '@storeweave/contracts';
import { ADMIN_ACTOR, createHarness, createProduct, type TestHarness } from './helpers';

/**
 * 每一次 Command / Query 都留下耗時（工單 53）。
 *
 * 三筆效能債的結論都是「先量再改」，而在這之前沒有任何一條路徑量得到自己：
 * CommandBus 只寫一行不帶耗時的 `command executed`，QueryBus 成功時一行都不寫。
 *
 * Query 的量級是「渲染次數」，所以成功走 debug、慢的走 warn：
 * 逐次 info 會把日誌淹掉，但慢的那幾筆必須在預設 level 就看得見。
 */
interface Line {
  level: 'debug' | 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
  msg?: string;
}

/**
 * 會保留 `child()` binding 的假 logger。
 * noopLogger 的 `child()` 回自己，於是 `command` / `query` 這些名字整個消失——
 * 用它來斷言，測到的只會是「有一行 log」而不是「哪一支的 log」。
 */
function recordingLogger(lines: Line[], bindings: Record<string, unknown> = {}): Logger {
  const write = (level: Line['level']) => (obj: unknown, msg?: string) => {
    const fields = typeof obj === 'object' && obj !== null ? obj as Record<string, unknown> : {};
    lines.push({ level, fields: { ...bindings, ...fields }, msg: typeof obj === 'string' ? obj : msg });
  };
  return {
    debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error'),
    child: (extra) => recordingLogger(lines, { ...bindings, ...extra }),
  };
}

let h: TestHarness;
const lines: Line[] = [];

beforeAll(async () => {
  h = await createHarness({ logger: recordingLogger(lines) });
}, 300_000);

afterAll(async () => {
  await h?.close();
});

/** 只看這一次呼叫寫出來的行：每個案例開始前先清空。 */
function freshLines(): void {
  lines.length = 0;
}

describe('Bus 記下執行時間（工單 53）', () => {
  it('成功的 Command 那一行帶得出 latencyMs', async () => {
    freshLines();
    await createProduct(h.runtime, { sku: `TIMING-${randomUUID().slice(0, 8)}` });

    const executed = lines.filter((l) => l.fields.command === 'commerce.catalog.createProduct' && l.msg === 'command executed');
    expect(executed).toHaveLength(1);
    expect(executed[0].level).toBe('info');
    expect(executed[0].fields.latencyMs).toBeGreaterThanOrEqual(0);
    // 既有的欄位沒有掉：那一行本來就帶得出是誰註冊的。
    expect(executed[0].fields.owner).toBe('catalog');
  });

  it('成功的 Query 走 debug——前台每渲染一次就打好幾支，逐次 info 會淹掉日誌', async () => {
    freshLines();
    await h.runtime.queries.execute('commerce.catalog.searchProducts', {}, { actor: ADMIN_ACTOR });

    const executed = lines.filter((l) => l.fields.query === 'commerce.catalog.searchProducts' && l.msg === 'query executed');
    expect(executed).toHaveLength(1);
    expect(executed[0].level).toBe('debug');
    expect(executed[0].fields.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('失敗的那次也有數字——逾時與慢查詢往往就是失敗的那幾筆', async () => {
    freshLines();
    await expect(
      h.runtime.queries.execute('commerce.catalog.getProduct', { id: randomUUID() }, { actor: ADMIN_ACTOR }),
    ).rejects.toBeInstanceOf(PlatformError);

    // 找不到商品是 4xx：帶著數字與錯誤碼，但停在 debug，不吵。
    const failed = lines.filter((l) => l.fields.query === 'commerce.catalog.getProduct' && l.msg === 'query failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].level).toBe('debug');
    expect(failed[0].fields).toMatchObject({ code: 'NOT_FOUND' });
    expect(failed[0].fields.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('冪等重放也有數字——重試風暴時最該量的就是它（工單 53 的審查發現）', async () => {
    const product = await createProduct(h.runtime, { sku: `TIMING-REPLAY-${randomUUID().slice(0, 8)}` });
    const idempotencyKey = randomUUID();
    const input = { productId: product.id, delta: 1, reason: 'restock' as const };
    await h.runtime.commands.execute('commerce.inventory.adjustStock', input, { actor: ADMIN_ACTOR, idempotencyKey });

    freshLines();
    await h.runtime.commands.execute('commerce.inventory.adjustStock', input, { actor: ADMIN_ACTOR, idempotencyKey });

    // 重放走的是交易內的捷徑，不經過成功那一行；沒有這條測試，重放就是量不到的黑洞。
    const replayed = lines.filter((l) => l.fields.command === 'commerce.inventory.adjustStock' && l.msg === 'command executed');
    expect(replayed).toHaveLength(1);
    expect(replayed[0].fields).toMatchObject({ replayed: true, idempotencyKey });
    expect(replayed[0].fields.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('Command 失敗那一行也有數字，而且例外原樣傳出去', async () => {
    // 扣到負數會被擋下（CONFLICT）。挑一個 handler 內部才失敗的情況，
    // 才驗得到 run() 抽出來之後「交易回滾 + 例外原樣往上」這條路。
    const product = await createProduct(h.runtime, { sku: `TIMING-FAIL-${randomUUID().slice(0, 8)}` });

    freshLines();
    await expect(
      h.runtime.commands.execute('commerce.inventory.adjustStock',
        { productId: product.id, delta: -5, reason: 'correction' },
        { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() }),
    ).rejects.toThrow(/Insufficient stock/);

    const failed = lines.filter((l) => l.fields.command === 'commerce.inventory.adjustStock' && l.msg === 'command failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].fields.latencyMs).toBeGreaterThanOrEqual(0);
    // 409 是 4xx：停在 debug，不吵。
    expect(failed[0].level).toBe('debug');
    expect(failed[0].fields).toMatchObject({ code: 'CONFLICT', owner: 'inventory' });
    // 成功那一行不該同時出現——交易回滾了，這次呼叫只有一個結局。
    expect(lines.filter((l) => l.msg === 'command executed')).toEqual([]);
  });

  it('correlationId 跟著那一行走——沒有它就串不回是哪一次請求', async () => {
    freshLines();
    await h.runtime.queries.execute('commerce.catalog.searchProducts', {}, { actor: ADMIN_ACTOR, correlationId: 'timing-corr-1' });

    const executed = lines.find((l) => l.msg === 'query executed');
    expect(executed!.fields.correlationId).toBe('timing-corr-1');
  });
});
