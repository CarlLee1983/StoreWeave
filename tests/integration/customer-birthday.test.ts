import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { httpStatusOf } from '@storeweave/contracts';
import { ADMIN_ACTOR, createCustomer, createHarness, type TestHarness } from './helpers';

/** 工單 74：生日填錯只能找客服改，而客服的更正要留下理由與原值。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const correct = (customerId: string, input: Record<string, unknown>) =>
  h.runtime.commands.execute<any>('commerce.customer.setCustomerBirthday', { customerId, ...input }, { actor: ADMIN_ACTOR });

describe('客服修正會員生日', () => {
  it('改得動，而且原值與理由都進得了稽核紀錄', async () => {
    const actor = await createCustomer(h.runtime, { email: `bday-${Date.now()}@example.com` });
    await correct(actor.customerId, { birthday: '1990-01-01', reason: '顧客註冊時漏填' });

    const updated = await correct(actor.customerId, { birthday: '1990-02-03', reason: '顧客來信說填錯月份' });
    expect(updated.birthday).toBe('1990-02-03');

    const audit = await h.runtime.database.db.execute<{ payload: any }>(sql`
      SELECT payload FROM platform_audit_log
      WHERE action = 'customer.birthday-corrected' AND resource_id = ${actor.customerId}
      ORDER BY occurred_at DESC LIMIT 1
    `);
    expect(audit.rows[0].payload).toMatchObject({ reason: '顧客來信說填錯月份', previousBirthday: '1990-01-01', birthday: '1990-02-03' });
  });

  it('沒有理由就不給改：事後查不到帳的更正等於沒有稽核', async () => {
    const actor = await createCustomer(h.runtime, { email: `bday-noreason-${Date.now()}@example.com` });
    const failure = await correct(actor.customerId, { birthday: '1991-03-04' }).catch((error) => error);
    expect(httpStatusOf(failure)).toBe(400);
    expect(JSON.stringify((failure as { details?: unknown }).details ?? failure)).toMatch(/reason/i);
  });
});
