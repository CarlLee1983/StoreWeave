import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '@storeweave/contracts';
import { PlatformError } from '@storeweave/contracts';
import type { PageResolveContext } from '@storeweave/kernel';
import { cartPages } from '../src/pages';

const guest: Actor = { id: 'guest', type: 'service', permissions: [] };
const customer: Actor = { id: 'cust-1', type: 'customer', permissions: [] };

const cart = (over: Record<string, unknown> = {}) => ({
  id: 'cart-1', currency: 'TWD', items: [], subtotalCents: 0, discountCents: 0, totalCents: 0,
  adjustments: [], nextThreshold: null, coupon: null, couponError: null, reward: null, removedNames: [],
  ...over,
});

/**
 * 真正的 ensureGuestCart／guestCartToken 在會員身分底下永遠不動 cookie
 * （`guestTokenFor`／`existingGuestToken` 內部就短路掉了），mock 要照樣短路，
 * 否則測試會在「會員不夾帶 guestToken」這件事上說謊。
 */
function makeCtx(over: { actor: Actor } & Record<string, unknown>): PageResolveContext {
  const actor = over.actor ?? customer;
  return {
    queries: { execute: vi.fn() },
    commands: { execute: vi.fn() },
    locale: 'zh-TW',
    clientKey: 'test-client',
    cookies: {
      guestCartToken: () => null,
      ensureGuestCart: () => (actor.type === 'customer' ? undefined as unknown as string : 'issued-guest-token'),
    },
    providers: { get: vi.fn(), has: vi.fn(() => false) },
    ...over,
  } as unknown as PageResolveContext;
}

describe('購物車頁', () => {
  it('已登入時不帶 guestToken 讀車', async () => {
    const execute = vi.fn(async () => cart({ id: 'cart-c' }));
    const ctx = makeCtx({ actor: customer, queries: { execute } });

    const outcome = await cartPages.view.resolve(ctx, {});

    expect(execute).toHaveBeenCalledWith('commerce.cart.getCart', { guestToken: undefined }, { actor: customer });
    expect(outcome).toMatchObject({ kind: 'view', view: { cartId: 'cart-c' } });
  });

  it('訪客帶著既有的 guestToken 讀車', async () => {
    const execute = vi.fn(async () => cart({ id: 'cart-g' }));
    const ctx = makeCtx({
      actor: guest, queries: { execute },
      cookies: { guestCartToken: () => 'existing-token', ensureGuestCart: () => 'existing-token' },
    });

    await cartPages.view.resolve(ctx, {});

    expect(execute).toHaveBeenCalledWith('commerce.cart.getCart', { guestToken: 'existing-token' }, { actor: guest });
  });
});

describe('加入購物車', () => {
  const parse = (raw: Record<string, string>) => cartPages.add.input.parse(raw);

  it('數量預設是 1，成功後轉址回購物車', async () => {
    const execute = vi.fn(async () => ({}));
    const ctx = makeCtx({ actor: customer, commands: { execute } });

    const outcome = await cartPages.add.resolve(ctx, parse({ productId: 'p1' }));

    expect(execute).toHaveBeenCalledWith('commerce.cart.addToCart', { productId: 'p1', quantity: 1 }, { actor: customer, idempotencyKey: expect.any(String) });
    expect(outcome).toEqual({ kind: 'redirect', location: '/cart' });
  });

  it('訪客會員沒有 guestToken 時不夾帶欄位', async () => {
    const execute = vi.fn(async () => ({}));
    const ctx = makeCtx({ actor: customer, commands: { execute }, cookies: { guestCartToken: () => null, ensureGuestCart: () => undefined as unknown as string } });

    await cartPages.add.resolve(ctx, parse({ productId: 'p1', quantity: '2' }));

    expect(execute).toHaveBeenCalledWith('commerce.cart.addToCart', { productId: 'p1', quantity: 2 }, expect.anything());
  });

  it('訪客簽發 guestToken 一併送出', async () => {
    const execute = vi.fn(async () => ({}));
    const ctx = makeCtx({ actor: guest, commands: { execute }, cookies: { guestCartToken: () => null, ensureGuestCart: () => 'new-token' } });

    await cartPages.add.resolve(ctx, parse({ productId: 'p1' }));

    expect(execute).toHaveBeenCalledWith('commerce.cart.addToCart', { productId: 'p1', quantity: 1, guestToken: 'new-token' }, expect.anything());
  });
});

describe('改量', () => {
  const parse = (raw: Record<string, string>) => cartPages.update.input.parse(raw);

  it('數量預設是 0（等同移除）', async () => {
    const execute = vi.fn(async () => ({}));
    const ctx = makeCtx({ actor: customer, commands: { execute } });

    const outcome = await cartPages.update.resolve(ctx, parse({ productId: 'p1' }));

    expect(execute).toHaveBeenCalledWith('commerce.cart.setCartItemQuantity', { productId: 'p1', quantity: 0 }, expect.anything());
    expect(outcome).toEqual({ kind: 'redirect', location: '/cart' });
  });
});

describe('清空購物車', () => {
  it('轉址回購物車', async () => {
    const execute = vi.fn(async () => ({}));
    const ctx = makeCtx({ actor: customer, commands: { execute } });

    const outcome = await cartPages.clear.resolve(ctx, {});

    expect(execute).toHaveBeenCalledWith('commerce.cart.clearCart', {}, expect.anything());
    expect(outcome).toEqual({ kind: 'redirect', location: '/cart' });
  });
});

describe('折扣碼', () => {
  const parse = (raw: Record<string, string>) => cartPages.coupon.input.parse(raw);

  it('移除折扣碼會走命令並轉址', async () => {
    const execute = vi.fn(async () => ({}));
    const ctx = makeCtx({ actor: customer, commands: { execute } });

    const outcome = await cartPages.coupon.resolve(ctx, parse({ remove: '1' }));

    expect(execute).toHaveBeenCalledWith('commerce.cart.removeCoupon', {}, expect.anything());
    expect(outcome).toEqual({ kind: 'redirect', location: '/cart' });
  });

  it('套用成功轉址回購物車', async () => {
    const execute = vi.fn(async () => ({}));
    const ctx = makeCtx({ actor: guest, commands: { execute }, cookies: { guestCartToken: () => null, ensureGuestCart: () => 'g-token' } });

    const outcome = await cartPages.coupon.resolve(ctx, parse({ code: ' SAVE10 ' }));

    expect(execute).toHaveBeenCalledWith('commerce.cart.applyCoupon', { code: 'SAVE10', guestToken: 'g-token' }, expect.anything());
    expect(outcome).toEqual({ kind: 'redirect', location: '/cart' });
  });

  it('套用失敗時回購物車視圖並帶錯誤訊息，不是錯誤頁', async () => {
    const commandExecute = vi.fn(async () => { throw PlatformError.validation('此折扣碼已過期'); });
    const queryExecute = vi.fn(async () => cart());
    const ctx = makeCtx({ actor: customer, commands: { execute: commandExecute }, queries: { execute: queryExecute } });

    const outcome = await cartPages.coupon.resolve(ctx, parse({ code: 'BAD' }));

    expect(outcome).toMatchObject({ kind: 'view', status: 400, view: { couponError: '此折扣碼已過期' } });
  });

  it('非 PlatformError 或 5xx 一律顯示中性訊息', async () => {
    const commandExecute = vi.fn(async () => { throw new Error('db down'); });
    const queryExecute = vi.fn(async () => cart());
    const ctx = makeCtx({ actor: customer, commands: { execute: commandExecute }, queries: { execute: queryExecute } });

    const outcome = await cartPages.coupon.resolve(ctx, parse({ code: 'X' }));

    expect(outcome).toMatchObject({ kind: 'view', status: 400, view: { couponError: '這組折扣碼無法使用。' } });
  });
});

describe('購物金折抵頁', () => {
  const parse = (raw: Record<string, string>) => cartPages.setRewards.input.parse(raw);

  it('金額換算成分並轉址回購物車', async () => {
    const execute = vi.fn(async () => ({}));

    const outcome = await cartPages.setRewards.resolve(makeCtx({ actor: customer, commands: { execute } }), parse({ amount: '12.5' }));

    expect(execute).toHaveBeenCalledWith('commerce.cart.setRewardRedemption', { amountCents: 1250 }, expect.objectContaining({ actor: customer }));
    expect(outcome).toEqual({ kind: 'redirect', location: '/cart' });
  });

  it('沒有帶金額時視為 0', async () => {
    const execute = vi.fn(async () => ({}));

    await cartPages.setRewards.resolve(makeCtx({ actor: customer, commands: { execute } }), parse({}));

    expect(execute).toHaveBeenCalledWith('commerce.cart.setRewardRedemption', { amountCents: 0 }, expect.objectContaining({ actor: customer }));
  });

  it('負數與非數字一律當作 0，不會產生負向折抵', () => {
    expect(parse({ amount: '-5' })).toEqual({ amountCents: 0 });
    expect(parse({ amount: 'abc' })).toEqual({ amountCents: 0 });
  });
});

describe('確認頁', () => {
  const shippingMethod = { id: 'ship-1', name: '宅配', destinationKind: 'taiwan_home', feeCents: 6000, freeShippingThresholdCents: null };
  const profile = { id: 'customer-1', address: null };

  const queryFor = (overrides: Record<string, unknown> = {}) => vi.fn(async (name: string) => {
    if (name === 'commerce.cart.getCart') return cart({ id: 'cart-1', items: [{ productId: 'p1' }], subtotalCents: 1000 });
    if (name === 'commerce.customer.getMyProfile') return { ...profile, email: 'a@b.com' };
    if (name === 'commerce.shipping.listShippingMethods') return { items: [shippingMethod] };
    if (name === 'commerce.shipping.quoteCheckoutShipping') return { shippingCents: 6000 };
    if (name === 'commerce.shipping.getPickupSelectionView') return overrides.pickupSelection ?? { store: null };
    throw new Error(`unexpected query ${name}`);
  });

  const paymentProvider = { id: 'ecpay', paymentMethods: () => [{ code: 'credit', label: '信用卡', timing: 'immediate' as const }] };

  it('購物車有東西時渲染確認頁', async () => {
    const providers = { get: vi.fn(() => paymentProvider), has: vi.fn(() => true) };
    const ctx = makeCtx({ actor: customer, queries: { execute: queryFor() }, providers });

    const outcome = await cartPages.checkoutView.resolve(ctx, {});

    expect(outcome).toMatchObject({
      kind: 'view',
      view: { selectedShippingMethodId: 'ship-1', customerEmail: 'a@b.com', payment: { provider: 'ecpay' } },
    });
  });

  it('購物車是空的就轉址回 /cart', async () => {
    const execute = vi.fn(async (name: string) => name === 'commerce.cart.getCart' ? cart({ items: [] }) : {});
    const ctx = makeCtx({ actor: customer, queries: { execute } });

    const outcome = await cartPages.checkoutView.resolve(ctx, {});

    expect(outcome).toEqual({ kind: 'redirect', location: '/cart' });
  });

  it('沒有可用配送方式是驗證錯誤', async () => {
    const execute = vi.fn(async (name: string) => {
      if (name === 'commerce.cart.getCart') return cart({ items: [{ productId: 'p1' }] });
      if (name === 'commerce.customer.getMyProfile') return profile;
      if (name === 'commerce.shipping.listShippingMethods') return { items: [] };
      return {};
    });
    const ctx = makeCtx({ actor: customer, queries: { execute } });

    await expect(cartPages.checkoutView.resolve(ctx, {})).rejects.toThrow(/No shipping method/);
  });

  it('取貨選擇沒有門市要擋下', async () => {
    const providers = { get: vi.fn(() => paymentProvider), has: vi.fn(() => true) };
    const execute = queryFor({ pickupSelection: { store: null, token: 't' } });
    const ctx = makeCtx({ actor: customer, queries: { execute }, providers });

    await expect(cartPages.checkoutView.resolve(ctx, { pickupSelectionToken: 't' })).rejects.toThrow(/convenience store/);
  });
});

describe('超商取貨門市挑選頁', () => {
  it('回傳門市清單', async () => {
    const execute = vi.fn(async (name: string) => {
      if (name === 'commerce.cart.getCart') return cart({ id: 'cart-1' });
      if (name === 'commerce.customer.getMyProfile') return { id: 'customer-1' };
      if (name === 'commerce.shipping.getPickupSelectionView') {
        return { provider: 'seven-eleven', shippingMethodId: 'ship-1', expiresAt: new Date('2026-01-01'), type: 'cvs' };
      }
      throw new Error(`unexpected ${name}`);
    });
    const provider = { id: 'seven-eleven', pickupStores: vi.fn(async () => [{ providerStoreId: 's1', storeName: '門市', storeAddress: '地址' }]) };
    const ctx = makeCtx({ actor: customer, queries: { execute }, providers: { get: vi.fn(() => provider), has: vi.fn(() => true) } });

    const outcome = await cartPages.pickupStorePicker.resolve(ctx, { token: 'tok' });

    expect(outcome).toMatchObject({ kind: 'view', view: { token: 'tok', stores: [{ providerStoreId: 's1' }] } });
  });

  it('provider 不支援門市挑選時是驗證錯誤', async () => {
    const execute = vi.fn(async (name: string) => {
      if (name === 'commerce.cart.getCart') return cart();
      if (name === 'commerce.customer.getMyProfile') return { id: 'customer-1' };
      return { provider: 'black-cat', type: 'cvs' };
    });
    const ctx = makeCtx({ actor: customer, queries: { execute }, providers: { get: vi.fn(() => ({ id: 'black-cat' })), has: vi.fn(() => true) } });

    await expect(cartPages.pickupStorePicker.resolve(ctx, { token: 'tok' })).rejects.toThrow(/store picker/);
  });
});

describe('超商取貨門市挑選啟動頁', () => {
  const parse = (raw: Record<string, string>) => cartPages.startPickupSelection.input.parse(raw);

  it('開出挑選流程後轉址帶著 token', async () => {
    const execute = vi.fn(async () => ({ token: 'tok/with special' }));

    const outcome = await cartPages.startPickupSelection.resolve(
      makeCtx({ actor: customer, commands: { execute } }), parse({ cartId: 'cart-1', shippingMethodId: 'method-1' }),
    );

    expect(execute).toHaveBeenCalledWith(
      'commerce.shipping.beginPickupSelection', { cartId: 'cart-1', shippingMethodId: 'method-1' },
      expect.objectContaining({ actor: customer }),
    );
    expect(outcome).toEqual({ kind: 'redirect', location: `/checkout/pickup/select?token=${encodeURIComponent('tok/with special')}` });
  });

  it('缺少欄位時仍轉發給命令，由命令自己驗證', async () => {
    const execute = vi.fn(async () => ({ token: 'tok' }));

    await cartPages.startPickupSelection.resolve(makeCtx({ actor: customer, commands: { execute } }), parse({}));

    expect(execute).toHaveBeenCalledWith(
      'commerce.shipping.beginPickupSelection', { cartId: undefined, shippingMethodId: undefined },
      expect.objectContaining({ actor: customer }),
    );
  });
});

describe('送出訂單', () => {
  const paymentProvider = { id: 'ecpay', paymentMethods: () => [{ code: 'credit', label: '信用卡', timing: 'immediate' as const }] };

  it('地址結帳成功後排入付款並轉址到訂單頁', async () => {
    const commandExecute = vi.fn(async (name: string) => {
      if (name === 'commerce.order.checkoutCart') return { id: 'order-1', number: 'N001' };
      return {};
    });
    const providers = { get: vi.fn(() => paymentProvider), has: vi.fn(() => true) };
    const ctx = makeCtx({ actor: customer, commands: { execute: commandExecute }, providers });

    const outcome = await cartPages.submit.resolve(ctx, cartPages.submit.input.parse({
      cartId: 'cart-1', shippingMethodId: 'ship-1', paymentMethod: 'credit',
      recipient: '王小明', phone: '0900000000', postcode: '100', city: '台北市', district: '中正區', line1: '忠孝路 1 號',
    }));

    expect(commandExecute).toHaveBeenNthCalledWith(1, 'commerce.order.checkoutCart', expect.objectContaining({
      cartId: 'cart-1', shippingMethodId: 'ship-1', destination: expect.objectContaining({ kind: 'taiwan_home', recipient: '王小明' }),
    }), expect.objectContaining({ actor: customer, idempotencyKey: 'cart:cust-1:cart-1' }));
    expect(commandExecute).toHaveBeenNthCalledWith(2, 'commerce.order.payOrder', {
      orderId: 'order-1', provider: 'ecpay', method: 'credit',
    }, expect.objectContaining({ actor: customer }));
    expect(outcome).toEqual({ kind: 'redirect', location: '/orders/N001' });
  });

  it('取貨結帳帶 pickupSelectionToken 時用取貨欄位取代地址', async () => {
    const commandExecute = vi.fn(async (name: string) => name === 'commerce.order.checkoutCart' ? { id: 'order-1', number: 'N002' } : {});
    const providers = { get: vi.fn(() => paymentProvider), has: vi.fn(() => true) };
    const ctx = makeCtx({ actor: customer, commands: { execute: commandExecute }, providers });

    await cartPages.submit.resolve(ctx, cartPages.submit.input.parse({
      cartId: 'cart-1', shippingMethodId: 'ship-1', paymentMethod: 'credit',
      pickupSelectionToken: 'tok', pickupRecipient: '王小明', pickupPhone: '0900000000',
    }));

    expect(commandExecute).toHaveBeenNthCalledWith(1, 'commerce.order.checkoutCart', expect.objectContaining({
      pickupSelectionToken: 'tok', pickupRecipient: '王小明', pickupPhone: '0900000000',
    }), expect.anything());
  });

  it('沒有選付款方式時擋在下單之前', async () => {
    const commandExecute = vi.fn(async () => ({}));
    const providers = { get: vi.fn(() => paymentProvider), has: vi.fn(() => true) };
    const ctx = makeCtx({ actor: customer, commands: { execute: commandExecute }, providers });

    await expect(cartPages.submit.resolve(ctx, cartPages.submit.input.parse({ cartId: 'cart-1' }))).rejects.toThrow(/付款方式/);
    expect(commandExecute).not.toHaveBeenCalled();
  });
});
