import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformError } from '@storeweave/contracts';
import { createMemoryLogger, type CapturedLine } from '@storeweave/kernel';
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
let h: TestHarness;
/**
 * 走正式那條 `createLogger()`，只是寫到記憶體：手刻的假 logger 驗不到 `redact()`
 * 與 level 過濾，而 Query 成功那一行正好停在 debug——那條路徑要真的能被擋掉才算數。
 */
let lines: CapturedLine[];

beforeAll(async () => {
  const memory = createMemoryLogger();
  lines = memory.lines;
  h = await createHarness({ logger: memory.logger });
}, 300_000);

afterAll(async () => {
  await h?.close();
});

/** 只看這一次呼叫寫出來的行：每個案例開始前先清空。 */
function freshLines(): void {
  lines.length = 0;
}

/**
 * Bus 那一行的訊息在慢的時候會多一個 `slow ` 前綴（`logBusCall`），而這支測試**控制不了
 * 這次呼叫要跑多久**——機器一忙就超過 `SLOW_CALL_MS`，精確比對 `msg` 於是一筆都撈不到，
 * 斷言收到空陣列（工單 55）。兩個變體都算數：這裡要驗的是那一行寫出來了、而且欄位對。
 *
 * 它自己有一條迴歸測試：認不得 `slow` 變體的過濾器，在「不該出現的那一行剛好很慢」時
 * 會安靜地放行，而那正是這支測試最該攔到迴歸的時候。
 */
function isBusMessage(msg: string | undefined, base: string): boolean {
  // msg 缺席就不是這一行。`CapturedLine.msg` 是選填的，pino 可以寫出不帶訊息的行。
  return msg === base || msg === `slow ${base}`;
}

function busLines(kind: 'command' | 'query', name: string, outcome: 'executed' | 'failed'): CapturedLine[] {
  return lines.filter((l) => l.fields[kind] === name && isBusMessage(l.msg, `${kind} ${outcome}`));
}

/**
 * 快慢各自該走哪個 level。訊息的前綴與 level 都由 `logBusCall` 裡的同一個 `slow` 決定，
 * 所以「訊息說慢、level 就得是 warn」是一個恆成立的關係——耗時控制不了，這個控制得了。
 * 這樣 level 那一格仍然驗得到，而不是為了不 flake 就整條放掉。
 */
function expectLevelMatchesSpeed(line: CapturedLine, fastLevel: 'info' | 'debug' | 'error'): void {
  expect(line.level).toBe(line.msg?.startsWith('slow ') ? 'warn' : fastLevel);
}

describe('Bus 記下執行時間（工單 53）', () => {
  it('成功的 Command 那一行帶得出 latencyMs', async () => {
    freshLines();
    await createProduct(h.runtime, { sku: `TIMING-${randomUUID().slice(0, 8)}` });

    const executed = busLines('command', 'commerce.catalog.createProduct', 'executed');
    expect(executed).toHaveLength(1);
    expectLevelMatchesSpeed(executed[0], 'info');
    expect(executed[0].fields.latencyMs).toBeGreaterThanOrEqual(0);
    // 既有的欄位沒有掉：那一行本來就帶得出是誰註冊的。
    expect(executed[0].fields.owner).toBe('catalog');
  });

  it('成功的 Query 走 debug——前台每渲染一次就打好幾支，逐次 info 會淹掉日誌', async () => {
    freshLines();
    await h.runtime.queries.execute('commerce.catalog.searchProducts', {}, { actor: ADMIN_ACTOR });

    const executed = busLines('query', 'commerce.catalog.searchProducts', 'executed');
    expect(executed).toHaveLength(1);
    expectLevelMatchesSpeed(executed[0], 'debug');
    expect(executed[0].fields.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('失敗的那次也有數字——逾時與慢查詢往往就是失敗的那幾筆', async () => {
    freshLines();
    await expect(
      h.runtime.queries.execute('commerce.catalog.getProduct', { id: randomUUID() }, { actor: ADMIN_ACTOR }),
    ).rejects.toBeInstanceOf(PlatformError);

    // 找不到商品是 4xx：帶著數字與錯誤碼，但停在 debug，不吵。
    const failed = busLines('query', 'commerce.catalog.getProduct', 'failed');
    expect(failed).toHaveLength(1);
    expectLevelMatchesSpeed(failed[0], 'debug');
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
    const replayed = busLines('command', 'commerce.inventory.adjustStock', 'executed');
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

    const failed = busLines('command', 'commerce.inventory.adjustStock', 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].fields.latencyMs).toBeGreaterThanOrEqual(0);
    // 409 是 4xx：停在 debug，不吵；慢的那次升 warn，不會變成 error。
    expectLevelMatchesSpeed(failed[0], 'debug');
    expect(failed[0].fields).toMatchObject({ code: 'CONFLICT', owner: 'inventory' });
    // 成功那一行不該同時出現——交易回滾了，這次呼叫只有一個結局。
    // 這裡尤其要認得 slow 變體：精確比對的話，真的多寫了一行而那次剛好慢，它會安靜放行。
    expect(lines.filter((l) => isBusMessage(l.msg, 'command executed'))).toEqual([]);
  });

  it('correlationId 跟著那一行走——沒有它就串不回是哪一次請求', async () => {
    freshLines();
    await h.runtime.queries.execute('commerce.catalog.searchProducts', {}, { actor: ADMIN_ACTOR, correlationId: 'timing-corr-1' });

    const executed = lines.find((l) => isBusMessage(l.msg, 'query executed'));
    expect(executed!.fields.correlationId).toBe('timing-corr-1');
  });
});

describe('過濾器認得慢的那個變體（工單 55）', () => {
  // 這一組是純函式，跟機器忙不忙無關——上面那些斷言全都建立在它身上，
  // 而它壞掉的方式是「安靜地少撈到東西」，不會自己吵。
  it('快慢兩種訊息都算同一件事', () => {
    expect(isBusMessage('command executed', 'command executed')).toBe(true);
    expect(isBusMessage('slow command executed', 'command executed')).toBe(true);
    expect(isBusMessage('query failed', 'query failed')).toBe(true);
    expect(isBusMessage('slow query failed', 'query failed')).toBe(true);
  });

  it('不同的一件事就是不同的一件事', () => {
    expect(isBusMessage('command failed', 'command executed')).toBe(false);
    expect(isBusMessage('slow command failed', 'command executed')).toBe(false);
    expect(isBusMessage('query executed', 'command executed')).toBe(false);
    // 前綴要整段對上，不是 includes——否則 'not slow command executed' 也會算數。
    expect(isBusMessage('very slow command executed', 'command executed')).toBe(false);
  });
});
