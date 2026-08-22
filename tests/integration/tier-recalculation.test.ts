import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { bucketFor, occurrenceKeyFor } from '@storeweave/kernel';
import { ADMIN_ACTOR, createCustomer, createHarness, type TestHarness } from './helpers';

/** 等級定期重算（工單 44）。 */

const DAY = 24 * 60 * 60 * 1000;
const RECALC_JOB = 'commerce.loyalty.recalculate-tiers';

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const recalculate = (input: Record<string, unknown> = {}) =>
  h.runtime.commands.execute<any>('commerce.loyalty.recalculateTiers', input,
    { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

const myTier = (actor: any) => h.runtime.queries.execute<any>('commerce.loyalty.getMyTier', {}, { actor });

const buyer = (tag: string) => createCustomer(h.runtime, { email: `recalc-${tag}-${randomUUID()}@example.test` });

/** 直接寫等級積分帳本：重算驗的是「帳本 → 等級」，不必繞一整條下單流程。 */
async function grantPoints(customerId: string, points: number, earnedAt: string) {
  await h.runtime.database.db.execute(sql`
    INSERT INTO loyalty_tier_entries (id, customer_id, points, source, earned_at)
    VALUES (${randomUUID()}, ${customerId}, ${points}, 'manual', ${earnedAt}::timestamptz)
  `);
}

const cachedTier = async (customerId: string) => {
  const rows = await h.runtime.database.db.execute<{ tier_name: string; previous_tier_name: string | null }>(sql`
    SELECT tier_name, previous_tier_name FROM loyalty_customer_tiers WHERE customer_id = ${customerId}
  `);
  return rows.rows[0] ?? null;
};

describe('重算', () => {
  it('升級：積分夠了就往上跳', async () => {
    const customer = await buyer('up');
    await grantPoints(customer.customerId, 5_000, new Date().toISOString());

    const result = await recalculate();

    expect(result.evaluated).toBeGreaterThan(0);
    expect((await cachedTier(customer.customerId))!.tier_name).toBe('銀卡');
    expect((await myTier(customer)).current.name).toBe('銀卡');
  });

  it('降級：積分掉出滾動期間就往下掉，而且看得出上一級是什麼', async () => {
    const customer = await buyer('down');
    await grantPoints(customer.customerId, 12_000, '2026-01-01T00:00:00.000Z');

    await recalculate({ at: new Date('2026-06-01T00:00:00.000Z') });
    expect((await cachedTier(customer.customerId))!.tier_name).toBe('金卡');

    // 一年後那筆積分掉出期間。
    await recalculate({ at: new Date('2027-02-01T00:00:00.000Z') });

    const cached = (await cachedTier(customer.customerId))!;
    expect(cached.tier_name).toBe('一般會員');
    expect(cached.previous_tier_name).toBe('金卡');
  });

  it('同一段期間重複執行結果相同', async () => {
    const customer = await buyer('idem');
    await grantPoints(customer.customerId, 4_000, new Date().toISOString());
    const at = new Date();

    const first = await recalculate({ at });
    const second = await recalculate({ at });

    expect(second.changed).toBe(0);
    expect(first.evaluated).toBe(second.evaluated);
    expect((await cachedTier(customer.customerId))!.tier_name).toBe('銀卡');
  });

  it('重複執行不會把「上一級」洗掉', async () => {
    const customer = await buyer('history');
    await grantPoints(customer.customerId, 12_000, '2026-01-01T00:00:00.000Z');
    await recalculate({ at: new Date('2026-06-01T00:00:00.000Z') });
    await recalculate({ at: new Date('2027-02-01T00:00:00.000Z') });

    await recalculate({ at: new Date('2027-02-02T00:00:00.000Z') });

    expect((await cachedTier(customer.customerId))!.previous_tier_name).toBe('金卡');
  });

  it('由每日的週期性工作執行，連續數個切片各排一次而且各跑一次', async () => {
    const t0 = new Date('2026-01-05T03:20:00.000Z');
    for (let i = 0; i < 3; i += 1) {
      await h.runtime.recurring.ensureScheduled(new Date(t0.getTime() + i * DAY));
      await h.worker.runJobs();
      await h.worker.runJobs();
    }

    const rows = await h.runtime.database.db.execute<{ dedupe_key: string; status: string }>(sql`
      SELECT dedupe_key, status FROM platform_jobs WHERE type = ${RECALC_JOB} ORDER BY dedupe_key
    `);
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.every((r) => r.status === 'completed')).toBe(true);
    expect(rows.rows.map((r) => r.dedupe_key)).toContain(occurrenceKeyFor(RECALC_JOB, bucketFor(t0, DAY)));
  });
});
