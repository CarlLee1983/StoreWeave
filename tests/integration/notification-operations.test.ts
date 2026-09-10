import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ACTOR, actorWith, checkoutInput, createHarness, createProduct, defaultCustomer, payOrder, settleWorker, stockUp, type TestHarness } from './helpers';

/** 工單 73：通知投遞紀錄的營運介面。營運要查得到「送給誰」，但不該把 email 攤開。 */

let h: TestHarness;
beforeAll(async () => {
  h = await createHarness({ extensions: { 'mock-payment': { autoApprove: true }, mcp: {} } });
}, 300_000);
afterAll(async () => { await h?.close(); });

async function paidOrder() {
  const product = await createProduct(h.runtime, { priceCents: 1200 });
  await stockUp(h.runtime, product.id, 2);
  const customer = await defaultCustomer(h.runtime);
  await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 }, { actor: customer, idempotencyKey: randomUUID() });
  const cart = await h.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor: customer });
  const order = await h.runtime.commands.execute<any>('commerce.order.checkoutCart', checkoutInput(h, cart.id), { actor: customer, idempotencyKey: randomUUID() });
  await payOrder(h.runtime, order.id);
  await settleWorker(h.worker);
  return order;
}

describe('通知投遞紀錄', () => {
  it('查得到這張訂單送出了哪些通知，收件人只給遮蔽值', async () => {
    const order = await paidOrder();
    const result = await h.runtime.queries.execute<any>('commerce.notification.listLifecycleDeliveries', { orderId: order.id }, { actor: ADMIN_ACTOR });
    expect(result.items.length).toBeGreaterThan(0);
    const delivery = result.items[0];
    expect(delivery).toMatchObject({ orderId: order.id, template: expect.stringMatching(/^customer\./) });
    // 投遞狀態由 base 通知能力供給；這個部署沒有設定 SMTP，因此是「跳過」而不是失敗。
    expect(['pending', 'sent', 'failed', 'skipped']).toContain(delivery.status);

    // 遮蔽是這張票的重點：查得到「送給誰」不等於把 email 攤在營運頁上。
    expect(delivery.recipientEmail).toBeUndefined();
    // 網域留著是刻意的：退信集中在某一家時看得出來。遮掉的是本地端。
    const [maskedLocal, maskedDomain] = delivery.recipientMasked.split('@');
    expect(maskedDomain).toBe('example.com');
    expect(maskedLocal).toMatch(/^.\*+$/);
    // 拿真值來比，不要靠拼字面值——helper 換個 email 前綴，拼出來的就是一個永遠不在字串裡的值。
    const { email } = await defaultCustomer(h.runtime);
    expect(JSON.stringify(delivery)).not.toContain(email.split('@')[0]);
    // variables 會帶顧客姓名與訂單細節，營運頁不需要它。
    expect(delivery.variables).toBeUndefined();
  });

  it('沒有 notification:read 的身分查不到投遞紀錄', async () => {
    await expect(h.runtime.queries.execute('commerce.notification.listLifecycleDeliveries', {}, { actor: actorWith(['order:read']) }))
      .rejects.toThrow(/permission|forbidden/i);
  });
});
