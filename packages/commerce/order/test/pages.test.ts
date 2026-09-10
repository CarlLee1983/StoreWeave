import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '@storeweave/contracts';
import { PlatformError } from '@storeweave/contracts';
import type { PageResolveContext } from '@storeweave/kernel';
import { orderPages } from '../src/pages';

const customer: Actor = { id: 'cust-1', type: 'customer', permissions: [] };

const order = (over: Record<string, unknown> = {}) => ({
  id: 'order-1', number: 'ORD-1', status: 'pending', currency: 'TWD', totalCents: 1000,
  lines: [{ id: 'l1' }], ...over,
});

const noProviders: PageResolveContext['providers'] = {
  get: vi.fn(() => { throw new Error('not used'); }),
  has: vi.fn(() => false),
};
const noCookies: PageResolveContext['cookies'] = { guestCartToken: () => null, ensureGuestCart: () => 'guest' };

const ctxWith = (
  execute: PageResolveContext['queries']['execute'],
  commandExecute: PageResolveContext['commands']['execute'] = vi.fn(),
  providers: PageResolveContext['providers'] = noProviders,
): PageResolveContext => ({
  queries: { execute },
  commands: { execute: commandExecute },
  actor: customer,
  locale: 'zh-TW',
  clientKey: 'client-1',
  cookies: noCookies,
  providers,
});

const paymentProvider = (methods: { code: string; label: string; timing: 'immediate' | 'deferred' }[] = []) => ({
  id: 'ecpay',
  paymentMethods: () => methods,
});

const fullOrder = (over: Record<string, unknown> = {}) => ({
  id: 'order-1', number: 'ORD-1', status: 'pending', currency: 'TWD', totalCents: 1000, customerEmail: 'a@example.test',
  lines: [{ id: 'l1', sku: 'SKU-1', name: '陶碗', quantity: 1, lineTotalCents: 1000 }],
  paymentAttempts: [], delivery: null, ...over,
});

const orderViewQueries = (order: Record<string, unknown>, over: Record<string, (name: string) => unknown> = {}) =>
  vi.fn(async (name: string) => {
    if (name === 'commerce.order.getOrder') return order;
    if (name === 'commerce.refund.listRefunds') return { items: [] };
    if (name === 'commerce.rma.listRmas') return { items: [] };
    if (name === 'commerce.shipping.getShipmentForOrder') return over.shipment?.(name) ?? Promise.reject(PlatformError.notFound('Shipment', 'order-1'));
    if (name === 'commerce.invoice.list') return { items: [] };
    throw new Error(`unexpected query ${name}`);
  });

describe('訂單明細頁', () => {
  it('待付款訂單帶出可重試的付款方式清單', async () => {
    const queries = orderViewQueries(fullOrder());
    const providers = { get: vi.fn(() => paymentProvider([{ code: 'credit', label: '信用卡', timing: 'immediate' }])), has: vi.fn(() => true) };

    const outcome = await orderPages.order.resolve(ctxWith(queries as never, vi.fn(), providers as never), { number: 'ORD-1' });

    expect(providers.get).toHaveBeenCalledWith('payment');
    expect(outcome).toMatchObject({
      kind: 'view',
      view: {
        number: 'ORD-1', canCancel: true,
        paymentRetry: { provider: 'ecpay', methods: [{ code: 'credit', label: '信用卡', timing: 'immediate' }] },
      },
    });
  });

  it('非待付款訂單不會查詢付款方式', async () => {
    const queries = orderViewQueries(fullOrder({ status: 'paid' }));
    const providers = { get: vi.fn(() => paymentProvider([{ code: 'credit', label: '信用卡', timing: 'immediate' }])), has: vi.fn(() => true) };

    const outcome = await orderPages.order.resolve(ctxWith(queries as never, vi.fn(), providers as never), { number: 'ORD-1' });

    expect(providers.get).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ view: { paymentRetry: null, canCancel: false } });
  });

  it('查不到出貨單時 shipment 是 null 而不是整頁失敗', async () => {
    const queries = orderViewQueries(fullOrder({ status: 'paid' }));

    const outcome = await orderPages.order.resolve(ctxWith(queries as never), { number: 'ORD-1' });

    expect(outcome).toMatchObject({ view: { shipment: null, canRequestRma: false } });
  });

  it('訂單不存在或不是自己的訂單時原樣拋出', async () => {
    const queries = vi.fn(async () => { throw PlatformError.notFound('Order', 'ORD-1'); });

    await expect(orderPages.order.resolve(ctxWith(queries as never), { number: 'ORD-1' })).rejects.toThrow(PlatformError);
  });
});

describe('重試付款', () => {
  it('選定的付款方式存在時建立新的付款嘗試並轉址回訂單頁', async () => {
    const queries = vi.fn(async () => order());
    const commands = vi.fn(async () => ({}));
    const provider = paymentProvider([{ code: 'credit', label: '信用卡', timing: 'immediate' }]);
    const providers = { get: vi.fn(() => provider), has: vi.fn(() => true) };

    const outcome = await orderPages.retryPayment.resolve(
      ctxWith(queries as never, commands as never, providers as never),
      { number: 'ORD-1', paymentProvider: 'ecpay', paymentMethod: 'credit' },
    );

    expect(providers.get).toHaveBeenCalledWith('payment', 'ecpay');
    expect(commands).toHaveBeenCalledWith('commerce.order.payOrder', {
      orderId: 'order-1', provider: 'ecpay', method: 'credit',
    }, { actor: customer, idempotencyKey: expect.stringContaining('storefront-pay:order-1:') });
    expect(outcome).toEqual({ kind: 'redirect', location: '/orders/ORD-1' });
  });

  it('付款方式不存在時回報驗證錯誤，不會建立付款嘗試', async () => {
    const queries = vi.fn(async () => order());
    const commands = vi.fn();
    const providers = { get: vi.fn(() => paymentProvider([{ code: 'credit', label: '信用卡', timing: 'immediate' }])), has: vi.fn(() => true) };

    await expect(orderPages.retryPayment.resolve(
      ctxWith(queries as never, commands as never, providers as never),
      { number: 'ORD-1', paymentProvider: undefined, paymentMethod: 'apple-pay' },
    )).rejects.toThrow('請先選擇可用的付款方式');
    expect(commands).not.toHaveBeenCalled();
  });

  it('provider registry 找不到指定的金流廠商時原樣拋出', async () => {
    const queries = vi.fn(async () => order());
    const commands = vi.fn();
    const providers = { get: vi.fn(() => { throw PlatformError.notFound('Provider', 'unknown'); }) };

    await expect(orderPages.retryPayment.resolve(
      ctxWith(queries as never, commands as never, providers as never),
      { number: 'ORD-1', paymentProvider: 'unknown', paymentMethod: 'credit' },
    )).rejects.toThrow(PlatformError);
    expect(commands).not.toHaveBeenCalled();
  });

  it('訂單不存在或不是自己的訂單時不會查詢付款方式', async () => {
    const queries = vi.fn(async () => { throw PlatformError.notFound('Order', 'ORD-1'); });
    const commands = vi.fn();
    const providers = { get: vi.fn(), has: vi.fn(() => true) };

    await expect(orderPages.retryPayment.resolve(
      ctxWith(queries as never, commands as never, providers as never),
      { number: 'ORD-1', paymentProvider: 'ecpay', paymentMethod: 'credit' },
    )).rejects.toThrow(PlatformError);
    expect(providers.get).not.toHaveBeenCalled();
    expect(commands).not.toHaveBeenCalled();
  });
});

describe('帳戶訂單清單頁', () => {
  it('沒有指定分頁時預設 limit 20 offset 0', async () => {
    const execute = vi.fn(async () => ({
      items: [{ number: 'ORD-1', status: 'paid', currency: 'TWD', totalCents: 1000, placedAt: new Date('2026-01-01'), lines: [{ id: 'l1' }, { id: 'l2' }] }],
      total: 1,
    }));

    const outcome = await orderPages.accountOrders.resolve(ctxWith(execute as never), { limit: undefined, offset: undefined });

    expect(execute).toHaveBeenCalledWith('commerce.order.listOrders', { limit: 20, offset: 0 }, { actor: customer });
    expect(outcome).toMatchObject({
      kind: 'view',
      view: { limit: 20, offset: 0, total: 1, orders: [{ number: 'ORD-1', lineCount: 2 }] },
    });
  });

  it('依指定的 limit 與 offset 查詢', async () => {
    const execute = vi.fn(async () => ({ items: [], total: 0 }));

    await orderPages.accountOrders.resolve(ctxWith(execute as never), { limit: '5', offset: '10' });

    expect(execute).toHaveBeenCalledWith('commerce.order.listOrders', { limit: '5', offset: '10' }, { actor: customer });
  });
});

describe('建立 RMA', () => {
  it('成立退貨並轉址回訂單頁', async () => {
    const queries = vi.fn(async () => order());
    const commands = vi.fn(async () => ({}));

    const outcome = await orderPages.createRma.resolve(ctxWith(queries as never, commands as never), {
      number: 'ORD-1', reason: '尺寸不合', orderLineId: 'l1', quantity_l1: '2',
    } as never);

    expect(queries).toHaveBeenCalledWith('commerce.order.getOrder', { number: 'ORD-1' }, { actor: customer });
    expect(commands).toHaveBeenCalledWith('commerce.rma.createRma', {
      orderId: 'order-1', reason: '尺寸不合', lines: [{ orderLineId: 'l1', quantity: 2 }],
    }, { actor: customer, idempotencyKey: expect.stringContaining('storefront-rma:order-1:') });
    expect(outcome).toEqual({ kind: 'redirect', location: '/orders/ORD-1' });
  });

  it('多筆退貨明細一起送出', async () => {
    const queries = vi.fn(async () => order());
    const commands = vi.fn(async () => ({}));

    await orderPages.createRma.resolve(ctxWith(queries as never, commands as never), {
      number: 'ORD-1', reason: '瑕疵', orderLineId: ['l1', 'l2'], quantity_l1: '1', quantity_l2: '3',
    } as never);

    expect(commands).toHaveBeenCalledWith('commerce.rma.createRma', expect.objectContaining({
      lines: [{ orderLineId: 'l1', quantity: 1 }, { orderLineId: 'l2', quantity: 3 }],
    }), expect.anything());
  });

  it('訂單不存在或不是自己的訂單時不會建立 RMA', async () => {
    const queries = vi.fn(async () => { throw PlatformError.notFound('Order', 'ORD-1'); });
    const commands = vi.fn();

    await expect(orderPages.createRma.resolve(ctxWith(queries as never, commands as never), {
      number: 'ORD-1', reason: '尺寸不合',
    } as never)).rejects.toThrow(PlatformError);
    expect(commands).not.toHaveBeenCalled();
  });
});

describe('取消訂單', () => {
  it('取消成立並轉址回訂單頁', async () => {
    const queries = vi.fn(async () => order());
    const commands = vi.fn(async () => ({}));

    const outcome = await orderPages.cancelOrder.resolve(ctxWith(queries as never, commands as never), { number: 'ORD-1' });

    expect(queries).toHaveBeenCalledWith('commerce.order.getOrder', { number: 'ORD-1' }, { actor: customer });
    expect(commands).toHaveBeenCalledWith('commerce.order.cancelOrder', {
      orderId: 'order-1', reason: 'customer request',
    }, { actor: customer, idempotencyKey: expect.stringContaining('storefront-cancel:order-1:') });
    expect(outcome).toEqual({ kind: 'redirect', location: '/orders/ORD-1' });
  });

  it('狀態不允許取消時，命令的衝突錯誤原樣往上拋', async () => {
    const queries = vi.fn(async () => order({ status: 'paid' }));
    const commands = vi.fn(async () => { throw PlatformError.conflict('Order ORD-1 cannot be cancelled (status=paid)'); });

    await expect(orderPages.cancelOrder.resolve(ctxWith(queries as never, commands as never), { number: 'ORD-1' }))
      .rejects.toThrow(/cannot be cancelled/);
  });

  it('找不到訂單時不會呼叫取消命令', async () => {
    const queries = vi.fn(async () => { throw PlatformError.notFound('Order', 'ORD-1'); });
    const commands = vi.fn();

    await expect(orderPages.cancelOrder.resolve(ctxWith(queries as never, commands as never), { number: 'ORD-1' }))
      .rejects.toThrow(PlatformError);
    expect(commands).not.toHaveBeenCalled();
  });
});
