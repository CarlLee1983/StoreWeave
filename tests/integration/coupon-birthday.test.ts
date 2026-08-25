import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { bucketFor, occurrenceKeyFor } from '@storeweave/kernel';
import { ADMIN_ACTOR, createCustomer, createHarness, type TestHarness } from './helpers';

/** 生日禮券（工單 35）。 */

const DAY = 24 * 60 * 60 * 1000;
const BIRTHDAY_JOB = 'commerce.coupon.issue-birthday-coupons';

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const created: string[] = [];

async function birthdayPromotion(overrides: Record<string, unknown> = {}) {
  const promotion = await h.runtime.commands.execute<any>('commerce.promotion.createPromotion', {
    name: '生日禮券',
    rule: { type: 'order_percentage', percentOffBasisPoints: 3_000 },
    requiresCoupon: true,
    autoIssue: 'birthday',
    autoIssueValidDays: 60,
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

const issueBirthday = (on?: Date) =>
  h.runtime.commands.execute<any>('commerce.coupon.issueBirthdayCoupons', on ? { on } : {},
    { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

const couponsOf = (customerId: string) =>
  h.runtime.queries.execute<any>('commerce.coupon.listCoupons', { customerId }, { actor: ADMIN_ACTOR });

/** 建一位有生日的會員。生日只有客服改得動，測試走那支命令。 */
async function customerBornOn(birthday: string | null, tag: string) {
  const customer = await createCustomer(h.runtime, { email: `bday-${tag}-${randomUUID()}@example.test` });
  if (birthday) {
    await h.runtime.commands.execute('commerce.customer.setCustomerBirthday',
      { customerId: customer.customerId, birthday, reason: '測試資料設定' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
  }
  return customer;
}

describe('生日禮券', () => {
  it('當天生日的會員收到券，別人沒有', async () => {
    await birthdayPromotion();
    const star = await customerBornOn('1990-08-22', 'star');
    const other = await customerBornOn('1990-08-23', 'other');

    const result = await issueBirthday(new Date('2026-08-22T02:00:00.000Z'));

    expect(result.monthDays).toEqual(['08-22']);
    const mine = (await couponsOf(star.customerId)).items;
    expect(mine).toHaveLength(1);
    expect(mine[0].source).toBe('birthday');
    expect((await couponsOf(other.customerId)).items).toEqual([]);
  });

  it('同一年重跑不會再發一張，隔年才會', async () => {
    await birthdayPromotion();
    const star = await customerBornOn('1988-05-05', 'again');

    await issueBirthday(new Date('2026-05-05T02:00:00.000Z'));
    await issueBirthday(new Date('2026-05-05T09:00:00.000Z'));
    expect((await couponsOf(star.customerId)).items).toHaveLength(1);

    await issueBirthday(new Date('2027-05-05T02:00:00.000Z'));
    expect((await couponsOf(star.customerId)).items).toHaveLength(2);
  });

  it('沒有設定生日的會員被略過', async () => {
    await birthdayPromotion();
    const nobody = await customerBornOn(null, 'nobody');

    await issueBirthday(new Date('2026-07-07T02:00:00.000Z'));

    expect((await couponsOf(nobody.customerId)).items).toEqual([]);
  });

  it('生日以店鋪時區判斷：UTC 還是前一天的時刻，台北已經是生日了', async () => {
    await birthdayPromotion();
    const star = await customerBornOn('1995-09-10', 'tz');

    // UTC 9/9 16:30 = 台北 9/10 00:30
    const result = await issueBirthday(new Date('2026-09-09T16:30:00.000Z'));

    expect(result.monthDays).toEqual(['09-10']);
    expect((await couponsOf(star.customerId)).items).toHaveLength(1);
  });

  it('平年的三月一日會補發給二月二十九日出生的人', async () => {
    await birthdayPromotion();
    const leapling = await customerBornOn('1996-02-29', 'leap');

    const result = await issueBirthday(new Date('2026-03-01T02:00:00.000Z'));

    expect(result.monthDays).toEqual(['03-01', '02-29']);
    expect((await couponsOf(leapling.customerId)).items).toHaveLength(1);
  });

  it('由每日的週期性工作執行，連續數個切片各排一次', async () => {
    const t0 = new Date('2026-01-05T03:20:00.000Z');
    for (let i = 0; i < 3; i += 1) {
      await h.runtime.recurring.ensureScheduled(new Date(t0.getTime() + i * DAY));
      await h.worker.runJobs();
      await h.worker.runJobs();
    }

    const rows = await h.runtime.database.db.execute<{ dedupe_key: string; status: string }>(sql`
      SELECT dedupe_key, status FROM platform_jobs WHERE type = ${BIRTHDAY_JOB} ORDER BY dedupe_key
    `);
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.every((r) => r.status === 'completed')).toBe(true);
    expect(rows.rows.map((r) => r.dedupe_key)).toContain(occurrenceKeyFor(BIRTHDAY_JOB, bucketFor(t0, DAY)));
  });
});
