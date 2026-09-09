import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ADMIN_ACTOR, createCustomer, createHarness, settleWorker, type TestHarness } from './helpers';

/** 新會員註冊自動發券（工單 34）。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const created: string[] = [];

async function signupPromotion(overrides: Record<string, unknown> = {}) {
  const promotion = await h.runtime.commands.execute<any>('commerce.promotion.createPromotion', {
    name: '新會員禮券',
    rule: { type: 'order_percentage', percentOffBasisPoints: 2_000 },
    requiresCoupon: true,
    autoIssue: 'signup',
    autoIssueValidDays: 30,
    ...overrides,
  }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
  created.push(promotion.id);
  return promotion;
}

afterEach(async () => {
  for (const id of created.splice(0)) {
    await h.runtime.commands.execute('commerce.promotion.setPromotionStatus', { id, status: 'disabled' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
  }
});

const couponsOf = (customerId: string) =>
  h.runtime.queries.execute<any>('commerce.coupon.listCoupons', { customerId }, { actor: ADMIN_ACTOR });

/** 通知是 base 能力：寄給誰、用哪個模板、帶什麼變數都留在 platform_notifications。 */
async function sentTo(email: string): Promise<any[]> {
  const rows = await h.runtime.database.db.execute<{ template_id: string; variables: any; reference: string }>(sql`
    SELECT template_id, variables, reference FROM platform_notifications WHERE recipient_email = ${email}
  `);
  return rows.rows.map((row) => ({ template: row.template_id, variables: row.variables, reference: row.reference }));
}

describe('註冊自動發券', () => {
  it('註冊事件送達之後，新會員手上就有一張綁定自己的券', async () => {
    const promotion = await signupPromotion();
    const customer = await createCustomer(h.runtime, { email: `signup-${randomUUID()}@example.test` });

    // 發券在事件投遞之後才發生：註冊本身不等它。
    expect((await couponsOf(customer.customerId)).items).toEqual([]);
    await settleWorker(h.worker);

    const { items } = await couponsOf(customer.customerId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      promotionId: promotion.id,
      customerId: customer.customerId,
      source: 'signup',
      status: 'issued',
    });
    expect(items[0].code).toMatch(/^[2-9A-HJ-NP-TV-Z-]+$/);
    expect(new Date(items[0].endsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('重複投遞不會發出第二張券', async () => {
    await signupPromotion();
    const customer = await createCustomer(h.runtime, { email: `signup-dup-${randomUUID()}@example.test` });

    await settleWorker(h.worker);
    // 重新排入同一筆投遞工作，模擬重投。
    await h.runtime.database.db.execute(sql`
      UPDATE platform_jobs SET status = 'pending', run_at = now() - interval '1 second'
      WHERE type = 'platform.event.deliver' AND payload->'event'->>'name' = 'commerce.customer.registered.v1'
    `);
    await settleWorker(h.worker);

    expect((await couponsOf(customer.customerId)).items).toHaveLength(1);
  });

  it('沒有設定自動發券的活動不會被發出來', async () => {
    await signupPromotion({ name: '不自動發的活動', autoIssue: undefined });
    const customer = await createCustomer(h.runtime, { email: `signup-none-${randomUUID()}@example.test` });
    await settleWorker(h.worker);

    expect((await couponsOf(customer.customerId)).items).toEqual([]);
  });

  it('發券失敗不影響註冊成功', async () => {
    await signupPromotion({ name: '發券會炸掉的活動' });
    const customer = await createCustomer(h.runtime, { email: `signup-fail-${randomUUID()}@example.test` });

    // 讓發券必定失敗。註冊已經成立且與它不在同一個交易內，因此不該受影響。
    await h.runtime.database.db.execute(sql`
      ALTER TABLE coupon_coupons ADD CONSTRAINT tmp_issue_fails CHECK (false) NOT VALID
    `);
    try {
      await settleWorker(h.worker);
    } finally {
      await h.runtime.database.db.execute(sql`ALTER TABLE coupon_coupons DROP CONSTRAINT tmp_issue_fails`);
    }

    const failed = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_jobs
      WHERE type = 'platform.event.deliver' AND attempts > 0 AND status <> 'completed'
    `);
    expect(Number(failed.rows[0].count)).toBeGreaterThan(0);

    // 會員還在，而且沒有半張券。
    const me = await h.runtime.queries.execute<any>('commerce.customer.getCustomer',
      { id: customer.customerId }, { actor: ADMIN_ACTOR });
    expect(me.id).toBe(customer.customerId);
    expect((await couponsOf(customer.customerId)).items).toEqual([]);
  });

  it('會員收到通知', async () => {
    await signupPromotion();
    const email = `signup-notify-${randomUUID()}@example.test`;
    await createCustomer(h.runtime, { email });
    await settleWorker(h.worker);

    const sent = await sentTo(email);
    expect(sent).toHaveLength(1);
    expect(sent[0].template).toBe('customer.coupon-signup');
  });
});
