import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformError } from '@storeweave/contracts';
import {
  ADMIN_ACTOR, actorWith, createCustomer, createHarness, createProduct, placeOrder, stockUp, type TestHarness,
} from './helpers';

/** 後台會員頁的資料面（工單 22）。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const list = (input: Record<string, unknown> = {}, actor = ADMIN_ACTOR) =>
  h.runtime.queries.execute<any>('commerce.customer.listCustomers', input, { actor });

const get = (customerId: string, actor = ADMIN_ACTOR) =>
  h.runtime.queries.execute<any>('commerce.customer.getCustomer', { id: customerId }, { actor });

describe('會員清單', () => {
  it('列得出會員，可搜尋 email 與顯示名稱，可分頁', async () => {
    const alice = await createCustomer(h.runtime, { email: 'admin-alice@example.com', displayName: '愛麗絲' });
    await createCustomer(h.runtime, { email: 'admin-bob@example.com', displayName: '巴布' });

    const all = await list({ limit: 100 });
    expect(all.total).toBeGreaterThanOrEqual(2);

    const byEmail = await list({ q: 'admin-alice' });
    expect(byEmail.items.map((c: any) => c.email)).toEqual(['admin-alice@example.com']);

    const byName = await list({ q: '巴布' });
    expect(byName.items.map((c: any) => c.displayName)).toEqual(['巴布']);

    const firstPage = await list({ limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.total).toBeGreaterThanOrEqual(2);
    expect(alice.email).toBeTruthy();
  });

  it('回應不含密碼雜湊或任何憑證欄位', async () => {
    await createCustomer(h.runtime, { email: 'admin-secret@example.com' });

    const serialized = JSON.stringify(await list({ q: 'admin-secret' }));

    expect(serialized).not.toMatch(/passwordHash|password_hash|scrypt/i);
  });

  it('顧客自己沒有列出全部會員的權限', async () => {
    const customer = await createCustomer(h.runtime);
    await expect(list({}, customer)).rejects.toThrow(PlatformError);
  });
});

describe('單一會員', () => {
  it('看得到個人資料與訂單歷史', async () => {
    const customer = await createCustomer(h.runtime, { email: 'admin-detail@example.com', displayName: '詳情' });
    const product = await createProduct(h.runtime, { sku: 'ADMIN-CUST', name: '後台會員頁' });
    await stockUp(h.runtime, product.id, 3);
    const order = await placeOrder(h.runtime, product.id, 1, customer);

    const detail = await get(customer.customerId);

    expect(detail).toMatchObject({ email: 'admin-detail@example.com', displayName: '詳情', status: 'active' });
    expect(detail.orders.map((o: any) => o.number)).toContain(order.number);
    expect(detail.orders[0]).toHaveProperty('totalCents');
  });
});

describe('停用與啟用', () => {
  it('停用後該會員無法登入，也無法下單', async () => {
    const customer = await createCustomer(h.runtime, { email: 'admin-disable@example.com' });
    const product = await createProduct(h.runtime, { sku: 'ADMIN-DISABLED', name: '停用測試' });
    await stockUp(h.runtime, product.id, 3);

    await h.runtime.commands.execute('commerce.customer.setCustomerStatus',
      { customerId: customer.customerId, status: 'disabled' }, { actor: ADMIN_ACTOR });

    await expect(h.runtime.auth.authenticate(h.runtime.database.db, {
      email: 'admin-disable@example.com', password: 'test-password',
    })).rejects.toThrow(PlatformError);

    await expect(placeOrder(h.runtime, product.id, 1, customer)).rejects.toThrow(/disabled/i);
  });

  it('啟用之後又能登入', async () => {
    const customer = await createCustomer(h.runtime, { email: 'admin-reenable@example.com' });

    await h.runtime.commands.execute('commerce.customer.setCustomerStatus',
      { customerId: customer.customerId, status: 'disabled' }, { actor: ADMIN_ACTOR });
    await h.runtime.commands.execute('commerce.customer.setCustomerStatus',
      { customerId: customer.customerId, status: 'active' }, { actor: ADMIN_ACTOR });

    const session = await h.runtime.auth.authenticate(h.runtime.database.db, {
      email: 'admin-reenable@example.com', password: 'test-password',
    });
    expect(session.token).toBeTruthy();
  });

  it('只有具備會員管理權限的人能停用', async () => {
    const customer = await createCustomer(h.runtime);
    await expect(h.runtime.commands.execute('commerce.customer.setCustomerStatus',
      { customerId: customer.customerId, status: 'disabled' }, { actor: actorWith(['customer:read']) },
    )).rejects.toThrow(/Forbidden/);
  });
});
