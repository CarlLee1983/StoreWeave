import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { bucketFor, occurrenceKeyFor } from '@storeweave/kernel';
import { ADMIN_ACTOR, createCustomer, createHarness, type TestHarness } from './helpers';

/** 購物金到期通知（工單 48）。 */

const DAY = 24 * 60 * 60 * 1000;
const NOTICE_JOB = 'commerce.loyalty.notify-expiring-rewards';

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const notify = (input: Record<string, unknown> = {}) =>
  h.runtime.commands.execute<any>('commerce.loyalty.notifyExpiringRewards', input,
    { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

const buyer = (tag: string) => createCustomer(h.runtime, { email: `exp-${tag}-${randomUUID()}@example.test` });

/** 直接寫一筆會過期的購物金：通知驗的是「帳本 → 通知」。 */
async function grantExpiring(customerId: string, amountCents: number, expiresInDays: number) {
  const id = randomUUID();
  await h.runtime.database.db.execute(sql`
    INSERT INTO loyalty_reward_entries (id, customer_id, amount_cents, source, effective_at, expires_at, created_at)
    VALUES (${id}, ${customerId}, ${amountCents}, 'manual', now() - interval '1 day',
            now() + (${expiresInDays} || ' days')::interval, now() - interval '1 day')
  `);
  return id;
}

/** 開發用通知實作把寄出的內容留在自己的儲存裡。 */
async function sentTo(email: string): Promise<any[]> {
  const rows = await h.runtime.database.db.execute<{ value: any }>(sql`
    SELECT value FROM platform_extension_state
    WHERE extension_id = 'mock-notification' AND key LIKE 'sent:%'
  `);
  return rows.rows.map((r) => r.value).filter((n) => n.to.email === email);
}

describe('到期通知', () => {
  it('設定天數內即將到期的批次會寄出通知', async () => {
    const customer = await buyer('soon');
    await grantExpiring(customer.customerId, 5_000, 3);

    const result = await notify();

    expect(result.notified).toBeGreaterThan(0);
    const sent = await sentTo(customer.email);
    expect(sent).toHaveLength(1);
    expect(sent[0].template).toBe('customer.reward-expiring');
  });

  it('還很久才到期的不會被通知', async () => {
    const customer = await buyer('far');
    await grantExpiring(customer.customerId, 5_000, 90);

    await notify();

    expect(await sentTo(customer.email)).toEqual([]);
  });

  it('同一批不會重複通知', async () => {
    const customer = await buyer('once');
    await grantExpiring(customer.customerId, 5_000, 3);

    await notify();
    const second = await notify();

    expect(await sentTo(customer.email)).toHaveLength(1);
    expect(second.skipped).toBeGreaterThan(0);
  });

  it('已經用完的批次不會被通知——沒有東西可以失去', async () => {
    const customer = await buyer('spent');
    await grantExpiring(customer.customerId, 5_000, 3);
    // 花掉它。
    await h.runtime.commands.execute('commerce.loyalty.adjustRewards',
      { customerId: customer.customerId, amountCents: -5_000, reason: '花掉' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    await notify();

    expect(await sentTo(customer.email)).toEqual([]);
  });

  it('通知的金額是「還剩多少」而不是原本發了多少', async () => {
    const customer = await buyer('partial');
    await grantExpiring(customer.customerId, 5_000, 3);
    await h.runtime.commands.execute('commerce.loyalty.adjustRewards',
      { customerId: customer.customerId, amountCents: -2_000, reason: '花掉一部分' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    await notify();

    const sent = await sentTo(customer.email);
    expect(sent[0].variables.amountCents).toBe(3_000);
  });

  it('邊界由注入的時刻決定：同一批在不同的時點通知或不通知', async () => {
    const customer = await buyer('edge');
    await grantExpiring(customer.customerId, 5_000, 30);

    // 預設十四天前通知：三十天後到期的現在還不必通知。
    await notify();
    expect(await sentTo(customer.email)).toEqual([]);

    await notify({ at: new Date(Date.now() + 20 * DAY) });
    expect(await sentTo(customer.email)).toHaveLength(1);
  });

  it('由每日的週期性工作執行', async () => {
    const t0 = new Date('2026-01-05T03:20:00.000Z');
    for (let i = 0; i < 2; i += 1) {
      await h.runtime.recurring.ensureScheduled(new Date(t0.getTime() + i * DAY));
      await h.worker.runJobs();
      await h.worker.runJobs();
    }

    const rows = await h.runtime.database.db.execute<{ dedupe_key: string; status: string }>(sql`
      SELECT dedupe_key, status FROM platform_jobs WHERE type = ${NOTICE_JOB} ORDER BY dedupe_key
    `);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r) => r.status === 'completed')).toBe(true);
    expect(rows.rows.map((r) => r.dedupe_key)).toContain(occurrenceKeyFor(NOTICE_JOB, bucketFor(t0, DAY)));
  });
});

/**
 * 寄不出去的那條路。用另一個 harness（`deliver: false` 的通知實作），
 * 因為那是啟動時的設定，不能中途改。
 */
describe('寄不出去時', () => {
  let broken: TestHarness;

  beforeAll(async () => {
    broken = await createHarness({
      extensions: {
        'mock-payment': { autoApprove: true },
        'mock-notification': { deliver: false, retainSensitiveVariables: true },
        'demo-erp': { endpoint: 'mock://demo-erp' },
        mcp: {},
      },
    });
  }, 300_000);

  afterAll(async () => { await broken?.close(); });

  it('不佔住那一批：下一輪還會再遇到它', async () => {
    const customer = await createCustomer(broken.runtime, { email: `exp-fail-${randomUUID()}@example.test` });
    const id = randomUUID();
    await broken.runtime.database.db.execute(sql`
      INSERT INTO loyalty_reward_entries (id, customer_id, amount_cents, source, effective_at, expires_at, created_at)
      VALUES (${id}, ${customer.customerId}, 5000, 'manual', now() - interval '1 day',
              now() + interval '3 days', now() - interval '1 day')
    `);

    const first = await broken.runtime.commands.execute<any>('commerce.loyalty.notifyExpiringRewards', {},
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    // 沒有寄出去就不能算成已通知，佔位也要放掉。
    expect(first.notified).toBe(0);
    const rows = await broken.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM loyalty_reward_expiry_notices WHERE entry_id = ${id}
    `);
    expect(rows.rows[0].count).toBe('0');
  });
});
