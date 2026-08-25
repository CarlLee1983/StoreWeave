import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PlatformError } from '@storeweave/contracts';
import { ADMIN_ACTOR, STOREFRONT_ACTOR, createCustomer, createHarness, type TestHarness } from './helpers';

/** 顧客個人資料與收件地址（工單 19）。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const profileOf = (actor: Parameters<typeof update>[0]) =>
  h.runtime.queries.execute<any>('commerce.customer.getMyProfile', {}, { actor });

const update = (actor: Awaited<ReturnType<typeof createCustomer>>, input: Record<string, unknown>) =>
  h.runtime.commands.execute<any>('commerce.customer.updateMyProfile', input, { actor });

describe('會員維護自己的資料', () => {
  it('讀得到自己的資料，一開始沒有生日、電話與地址', async () => {
    const customer = await createCustomer(h.runtime, { displayName: '小明' });

    const profile = await profileOf(customer);

    expect(profile).toMatchObject({ displayName: '小明', birthday: null, phone: null, address: null });
  });

  it('改得了顯示名稱、電話與收件地址', async () => {
    const customer = await createCustomer(h.runtime);

    const updated = await update(customer, {
      displayName: '王小明',
      phone: '0912345678',
      address: { recipient: '王小明', phone: '0912345678', postcode: '106', city: '台北市', line1: '大安區信義路三段 1 號', line2: '5 樓' },
    });

    expect(updated.displayName).toBe('王小明');
    expect(updated.address).toMatchObject({ city: '台北市', line1: '大安區信義路三段 1 號', line2: '5 樓' });
    expect((await profileOf(customer)).phone).toBe('0912345678');
  });

  it('只送一個欄位不會清掉其他欄位', async () => {
    const customer = await createCustomer(h.runtime);
    await update(customer, { phone: '0900000000' });

    const updated = await update(customer, { displayName: '只改名字' });

    expect(updated.displayName).toBe('只改名字');
    expect(updated.phone).toBe('0900000000');
  });

  it('生日可以自己設定一次，之後要改得找客服', async () => {
    const customer = await createCustomer(h.runtime);

    const set = await update(customer, { birthday: '1990-05-20' });
    expect(set.birthday).toBe('1990-05-20');

    await expect(update(customer, { birthday: '1991-06-21' })).rejects.toThrow(/birthday/i);
    expect((await profileOf(customer)).birthday).toBe('1990-05-20');
  });

  it('生日的格式要是 YYYY-MM-DD', async () => {
    const customer = await createCustomer(h.runtime);
    await expect(update(customer, { birthday: '05/20/1990' })).rejects.toThrow();
  });

  it('後台可以代為修改已設定的生日（客服協助）', async () => {
    const customer = await createCustomer(h.runtime);
    await update(customer, { birthday: '1990-05-20' });

    const fixed = await h.runtime.commands.execute<any>('commerce.customer.setCustomerBirthday',
      { customerId: (await profileOf(customer)).id, birthday: '1990-06-21', reason: '顧客來信更正' },
      { actor: ADMIN_ACTOR });

    expect(fixed.birthday).toBe('1990-06-21');
  });
});

describe('別人的資料碰不到', () => {
  it('顧客只讀得到自己的那一份', async () => {
    const alice = await createCustomer(h.runtime, { displayName: '小美' });
    const bob = await createCustomer(h.runtime, { displayName: '小華' });

    expect((await profileOf(alice)).displayName).toBe('小美');
    expect((await profileOf(bob)).displayName).toBe('小華');
    expect((await profileOf(alice)).id).not.toBe((await profileOf(bob)).id);
  });

  it('匿名訪客讀不到也改不了', async () => {
    await expect(h.runtime.queries.execute('commerce.customer.getMyProfile', {}, { actor: STOREFRONT_ACTOR }))
      .rejects.toThrow(PlatformError);
    await expect(h.runtime.commands.execute('commerce.customer.updateMyProfile', { displayName: 'x' }, { actor: STOREFRONT_ACTOR }))
      .rejects.toThrow(PlatformError);
  });

  it('後台身分呼叫「我的」資料會被明確拒絕，而不是回一份空的', async () => {
    await expect(h.runtime.queries.execute('commerce.customer.getMyProfile', {}, { actor: ADMIN_ACTOR }))
      .rejects.toThrow(/signed-in customer/i);
  });
});

describe('稽核', () => {
  it('每一次寫入都留下紀錄，且不含電話與地址內容', async () => {
    const customer = await createCustomer(h.runtime);
    await update(customer, { phone: '0987654321', displayName: '留紀錄' });
    const profile = await profileOf(customer);

    const rows = await h.runtime.database.db.execute<{ action: string; actor_type: string; payload: unknown }>(sql`
      SELECT action, actor_type, payload FROM platform_audit_log
      WHERE resource_type = 'customer' AND resource_id = ${profile.id} AND action = 'customer.profile-updated'
    `);

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].actor_type).toBe('customer');
    expect(JSON.stringify(rows.rows[0].payload ?? {})).not.toContain('0987654321');
  });
});
