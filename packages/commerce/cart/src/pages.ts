import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError } from '@storeweave/contracts';
import { definePage, formValue, type PageResolveContext, type StorefrontHttpContract } from '@storeweave/kernel';
import type { PaymentProvider, ShippingProvider } from '@storeweave/extension-sdk';
import type { JsonSchema7Type } from 'zod-to-json-schema';

/** 一行購物車明細在前台看得到的樣子。 */
export interface ThemeCartLineView {
  productId: string;
  sku: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
  /** 攤到這一行的折扣與折後金額。 */
  discountCents: number;
  netCents: number;
  /** 目前可售量，null 代表沒有庫存紀錄。購物車不預留，這只是顯示用。 */
  available: number | null;
}

/**
 * 購物車的呈現資料。金額全部是**當下**重算的結果——購物車不凍結價格，
 * Theme 拿到的永遠是現在的數字。
 */
export interface ThemeCartView {
  /** 結帳表單要把它帶回來：它是那次結帳的冪等鍵。 */
  cartId: string;
  currency: string;
  lines: ThemeCartLineView[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  adjustments: { name: string; amountCents: number }[];
  /** 已經買不到而被拿掉的商品。顧客要在結帳之前就知道。 */
  removedNames: string[];
  /** 差一點就達成的門檻活動；沒有就是 null。 */
  nextThreshold: { name: string; remainingCents: number } | null;
  /** 本次套用的券。券不生效時 `discountCents` 是 0。 */
  coupon: { code: string; discountCents: number } | null;
  /** 券失效或輸入錯誤的原因。留著訊息而不是靜靜拿掉，顧客才知道發生了什麼。 */
  couponError: string | null;
  /**
   * 購物金折抵。未登入時為 null——訪客沒有帳本。
   * `requestedCents` 與 `appliedCents` 不同時，畫面要說得出為什麼。
   */
  reward: {
    requestedCents: number;
    appliedCents: number;
    availableCents: number;
    maxCents: number;
  } | null;
  error?: string;
}

/** 確認頁：購物車的資料加上結帳才需要的配送與付款選項。 */
export interface ThemeCheckoutView extends ThemeCartView {
  /** 訂單會寄到哪裡。結帳必須是會員，因此它一定有值。 */
  customerEmail: string;
  /** Merchant methods compatible with address or pickup checkout. */
  shippingMethods: {
    id: string;
    name: string;
    /** Omitted by older themes/tests; it retains the historical home-delivery rendering. */
    destinationKind?: 'taiwan_home' | 'pickup_store';
    feeCents: number;
    freeShippingThresholdCents: number | null;
  }[];
  /** The selected merchant method and all-in amount are server-derived for this render. */
  selectedShippingMethodId: string;
  shippingPreview: { shippingCents: number; totalCents: number };
  /** Prefill only: the form still submits a fresh, explicit destination. */
  deliveryAddress: {
    recipient: string;
    phone: string;
    postcode: string;
    city: string;
    district: string | null;
    line1: string;
    line2: string | null;
  } | null;
  pickupSelection?: { token: string; storeName: string; storeAddress: string } | null;
  /** The store selects a provider; the customer must select its configured method before redirection. */
  payment: {
    provider: string;
    methods: { code: string; label: string; timing: 'immediate' | 'deferred' }[];
  };
  /** Present only when the merchant has enabled a B2C invoice provider. */
  invoice?: { enabled: boolean };
}

export interface ThemePickupStorePickerView {
  token: string;
  shippingMethodId: string;
  expiresAt: Date;
  stores: { providerStoreId: string; storeName: string; storeAddress: string }[];
}

const notice = ['cart-notice-consume'] as const;

const jsonSchema = (fields: readonly string[]): JsonSchema7Type => ({
  type: 'object',
  properties: Object.fromEntries(fields.map(field => [field, { type: 'string' }])),
  additionalProperties: true,
} as JsonSchema7Type);

const html = (status: number | 'platform-error'): StorefrontHttpContract['responses'][number] =>
  ({ kind: 'html', status, contentType: 'text/html; charset=utf-8', body: 'theme' });
const htmlOnly: StorefrontHttpContract['responses'] = [html(200), html('platform-error')];
const redirectFixed = (value: string): StorefrontHttpContract['responses'][number] =>
  ({ kind: 'redirect', status: 303, location: { kind: 'fixed', value } });
const redirectServerConstructed: StorefrontHttpContract['responses'][number] =
  { kind: 'redirect', status: 303, location: { kind: 'server-constructed' } };

/** 購物車頁與確認頁看的是同一份資料，差別只在能不能改。 */
async function loadCartView(ctx: PageResolveContext): Promise<ThemeCartView> {
  const cart = await ctx.queries.execute<any>(
    'commerce.cart.getCart',
    { guestToken: ctx.cookies.guestCartToken() ?? undefined },
    { actor: ctx.actor },
  );
  return {
    cartId: cart.id,
    currency: cart.currency,
    lines: cart.items,
    subtotalCents: cart.subtotalCents,
    discountCents: cart.discountCents,
    totalCents: cart.totalCents,
    adjustments: cart.adjustments,
    nextThreshold: cart.nextThreshold,
    coupon: cart.coupon,
    couponError: cart.couponError,
    reward: cart.reward,
    removedNames: cart.removedNames,
  };
}

/** 購物車的寫入一律回到 /cart：POST 之後轉址，重新整理才不會再送一次。 */
async function submitCartCommand(
  ctx: PageResolveContext, name: string, input: Record<string, unknown>,
): Promise<{ kind: 'redirect'; location: string }> {
  const guestToken = ctx.cookies.ensureGuestCart();
  await ctx.commands.execute(name, {
    ...input,
    // 會員沒有 guestToken；有些購物車命令是 strict 的，多送一個欄位會被擋下。
    ...(guestToken ? { guestToken } : {}),
  }, { actor: ctx.actor, idempotencyKey: randomUUID() });
  return { kind: 'redirect', location: '/cart' };
}

function invoicePreferenceFromForm(body: Record<string, string | undefined>) {
  switch (body.invoicePreference) {
    case 'mobile': return { kind: 'mobile' as const, number: body.invoiceCarrierNumber?.trim() ?? '' };
    case 'natural_person': return { kind: 'natural_person' as const, number: body.invoiceCarrierNumber?.trim() ?? '' };
    case 'donation': return { kind: 'donation' as const, loveCode: body.invoiceLoveCode?.trim() ?? '' };
    default: return { kind: 'ecpay' as const };
  }
}

/**
 * 輸入是「元」而且允許小數：折抵額不見得是整數元（餘額或小計都可能不是），
 * 用整數元來回換算會讓每一次重送都少折幾分。
 */
const cartRewardsInput = z.object({ amount: formValue.optional() }).transform(({ amount }) => {
  const parsed = Number(amount ?? '0');
  return { amountCents: Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0 };
});

const startPickupSelectionInput = z.object({
  cartId: formValue.optional(),
  shippingMethodId: formValue.optional(),
});

const addToCartInput = z.object({ productId: formValue.optional(), quantity: formValue.optional() })
  .transform(({ productId, quantity }) => ({ productId, quantity: Number.parseInt(quantity ?? '1', 10) }));

/** 數量設成 0 就是移除——前台的數量欄位本來就會走到 0，讓它自然表達「不要了」。 */
const setCartItemQuantityInput = z.object({ productId: formValue, quantity: formValue.optional() })
  .transform(({ productId, quantity }) => ({ productId, quantity: Number.parseInt(quantity ?? '0', 10) }));

const cartCouponInput = z.object({ code: formValue.optional(), remove: formValue.optional() })
  .transform(({ code, remove }) => ({ code: code ?? '', remove: Boolean(remove) }));

const checkoutPageInput = z.object({
  shippingMethodId: formValue.optional(),
  pickupSelectionToken: formValue.optional(),
});

const pickupStorePickerInput = z.object({ token: formValue });

const checkoutInput = z.object({
  cartId: formValue.optional(),
  shippingMethodId: formValue.optional(),
  pickupSelectionToken: formValue.optional(),
  pickupRecipient: formValue.optional(),
  pickupPhone: formValue.optional(),
  recipient: formValue.optional(),
  phone: formValue.optional(),
  postcode: formValue.optional(),
  city: formValue.optional(),
  district: formValue.optional(),
  line1: formValue.optional(),
  line2: formValue.optional(),
  paymentProvider: formValue.optional(),
  paymentMethod: formValue.optional(),
  invoicePreference: formValue.optional(),
  invoiceCarrierNumber: formValue.optional(),
  invoiceLoveCode: formValue.optional(),
});

export const cartPages = {
  /** 購物車頁。 */
  view: definePage({
    id: 'commerce.cart.view',
    path: '/cart',
    method: 'get',
    audience: 'public',
    input: z.object({}),
    contract: {
      kind: 'storefront', request: 'none', input: jsonSchema([]), responses: htmlOnly, cookieEffects: notice,
    },
    resolve: async (ctx) => ({ kind: 'view', view: await loadCartView(ctx) }),
  }),

  /** 加入購物車。 */
  add: definePage({
    id: 'commerce.cart.add',
    path: '/cart/items',
    method: 'post',
    audience: 'public',
    required: false,
    input: addToCartInput,
    contract: {
      kind: 'storefront', request: 'form', rateLimit: 'cart', input: jsonSchema(['productId', 'quantity']),
      responses: [html('platform-error'), redirectFixed('/cart')], cookieEffects: ['guest-cart-ensure', ...notice],
    },
    resolve: (ctx, { productId, quantity }) => submitCartCommand(ctx, 'commerce.cart.addToCart', { productId, quantity }),
  }),

  /** 改量。 */
  update: definePage({
    id: 'commerce.cart.update',
    path: '/cart/items/:productId',
    method: 'post',
    audience: 'public',
    required: false,
    input: setCartItemQuantityInput,
    contract: {
      kind: 'storefront', request: 'form', rateLimit: 'cart', input: jsonSchema(['productId', 'quantity']),
      params: { productId: 'productId' },
      responses: [html('platform-error'), redirectFixed('/cart')], cookieEffects: ['guest-cart-ensure', ...notice],
    },
    resolve: (ctx, { productId, quantity }) => submitCartCommand(ctx, 'commerce.cart.setCartItemQuantity', { productId, quantity }),
  }),

  /** 清空購物車。Spec 0003 User Story 5，也是顧客卡住時唯一的自救手段。 */
  clear: definePage({
    id: 'commerce.cart.clear',
    path: '/cart/clear',
    method: 'post',
    audience: 'public',
    required: false,
    input: z.object({}),
    contract: {
      kind: 'storefront', request: 'none', rateLimit: 'cart', input: jsonSchema([]),
      responses: [html('platform-error'), redirectFixed('/cart')], cookieEffects: ['guest-cart-ensure', ...notice],
    },
    resolve: (ctx) => submitCartCommand(ctx, 'commerce.cart.clearCart', {}),
  }),

  /** 折扣碼：套用或移除。這條路由與 REST 端點同樣受節流保護（掃碼機器人）。 */
  coupon: definePage({
    id: 'commerce.cart.coupon',
    path: '/cart/coupon',
    method: 'post',
    audience: 'public',
    // 無效的碼會把購物車頁重新渲染出來（400），所以這一頁有畫面，不是純轉址。
    required: true,
    input: cartCouponInput,
    contract: {
      kind: 'storefront', request: 'form', rateLimit: 'coupon', input: jsonSchema(['code', 'remove']),
      responses: [html(400), html('platform-error'), redirectFixed('/cart')], cookieEffects: ['guest-cart-ensure', ...notice],
    },
    resolve: async (ctx, { code, remove }) => {
      if (remove) return submitCartCommand(ctx, 'commerce.cart.removeCoupon', {});
      // 無效的碼不是錯誤頁：把原因留在購物車頁上，顧客才改得了。
      try {
        await ctx.commands.execute('commerce.cart.applyCoupon', {
          code: code.trim(), guestToken: ctx.cookies.ensureGuestCart(),
        }, { actor: ctx.actor, idempotencyKey: randomUUID() });
        return { kind: 'redirect', location: '/cart' };
      } catch (err) {
        const message = err instanceof PlatformError && err.httpStatus < 500 ? err.message : '這組折扣碼無法使用。';
        return { kind: 'view', status: 400, view: { ...await loadCartView(ctx), couponError: message } };
      }
    },
  }),

  /**
   * 折抵多少購物金。POST 之後一律回到 /cart：重新整理才不會再送一次。
   */
  setRewards: definePage({
    id: 'commerce.cart.setRewards',
    loginNext: () => '/cart',
    path: '/cart/rewards',
    method: 'post',
    audience: 'customer',
    required: false,
    input: cartRewardsInput,
    contract: {
      kind: 'storefront', request: 'form', rateLimit: 'cart', input: jsonSchema(['amount']), audience: 'customer',
      responses: [html('platform-error'), redirectFixed('/cart'), redirectFixed('/login?next=%2Fcart')],
      cookieEffects: notice,
    },
    resolve: async (ctx, { amountCents }) => {
      await ctx.commands.execute('commerce.cart.setRewardRedemption', { amountCents }, { actor: ctx.actor, idempotencyKey: randomUUID() });
      return { kind: 'redirect', location: '/cart' };
    },
  }),

  /** 確認頁。內容不能在這裡改，否則「確認的東西」與「結出來的單」會是兩份。 */
  checkoutView: definePage({
    id: 'commerce.checkout.view',
    path: '/checkout',
    method: 'get',
    audience: 'customer',
    input: checkoutPageInput,
    contract: {
      kind: 'storefront', request: 'query', input: jsonSchema(['shippingMethodId', 'pickupSelectionToken']),
      audience: 'customer', responses: [html(200), html('platform-error'), redirectServerConstructed], cookieEffects: notice,
    },
    resolve: async (ctx, { shippingMethodId: requestedShippingMethodId, pickupSelectionToken }) => {
      const [view, profile, methods] = await Promise.all([
        loadCartView(ctx),
        ctx.queries.execute<{
          id: string;
          address: { recipient: string; phone: string; postcode: string; city: string; district: string | null; line1: string; line2: string | null } | null;
        }>('commerce.customer.getMyProfile', {}, { actor: ctx.actor }),
        ctx.queries.execute<{ items: any[] }>(
          'commerce.shipping.listShippingMethods', { enabled: true, limit: 100, offset: 0 }, { actor: ctx.actor },
        ),
      ]);
      if (view.lines.length === 0) return { kind: 'redirect', location: '/cart' };
      const shippingMethods = methods.items.map((method) => ({
        id: method.id,
        name: method.name,
        destinationKind: method.destinationKind,
        feeCents: method.feeCents,
        freeShippingThresholdCents: method.freeShippingThresholdCents,
      }));
      if (shippingMethods.length === 0) {
        throw PlatformError.validation('No shipping method is currently available');
      }
      const selectedShippingMethodId = requestedShippingMethodId || shippingMethods[0]!.id;
      if (!shippingMethods.some((method) => method.id === selectedShippingMethodId)) {
        throw PlatformError.validation('請選擇可用的配送方式');
      }
      // The selected fee comes from Shipping, not the form or its displayed
      // method data. `view` itself is also a fresh server-side cart projection.
      const shippingPreview = await ctx.queries.execute<{ shippingCents: number }>(
        'commerce.shipping.quoteCheckoutShipping',
        {
          shippingMethodId: selectedShippingMethodId,
          subtotalCents: view.subtotalCents,
          destinationKind: shippingMethods.find((method) => method.id === selectedShippingMethodId)!.destinationKind,
        },
        { actor: ctx.actor },
      );
      const provider = ctx.providers.get<PaymentProvider>('payment');
      const paymentMethods = provider.paymentMethods();
      if (paymentMethods.length === 0) {
        throw PlatformError.validation(`Payment provider ${provider.id} has no enabled payment methods`);
      }
      const customerEmail = await ctx.queries.execute<{ email: string }>(
        'commerce.customer.getMyProfile', {}, { actor: ctx.actor },
      ).then((result) => result.email);
      const selection = pickupSelectionToken
        ? await ctx.queries.execute<any>('commerce.shipping.getPickupSelectionView', {
          token: pickupSelectionToken, cartId: view.cartId, customerId: profile.id, shippingMethodId: selectedShippingMethodId,
        }, { actor: ctx.actor })
        : null;
      if (selection && !selection.store) throw PlatformError.validation('Please choose a convenience store before checkout');
      const invoiceEnabled = ctx.providers.has('invoice');
      return {
        kind: 'view',
        view: {
          ...view,
          customerEmail,
          shippingMethods,
          selectedShippingMethodId,
          shippingPreview: { shippingCents: shippingPreview.shippingCents, totalCents: view.totalCents + shippingPreview.shippingCents },
          deliveryAddress: profile.address ? {
            recipient: profile.address.recipient, phone: profile.address.phone, postcode: profile.address.postcode,
            city: profile.address.city, district: profile.address.district, line1: profile.address.line1, line2: profile.address.line2,
          } : null,
          pickupSelection: selection?.store ? { token: selection.token, storeName: selection.store.storeName, storeAddress: selection.store.storeAddress } : null,
          payment: {
            provider: provider.id,
            methods: paymentMethods.map((method) => ({ code: method.code, label: method.label, timing: method.timing })),
          },
          invoice: invoiceEnabled ? { enabled: true } : undefined,
        } satisfies ThemeCheckoutView,
      };
    },
  }),

  /** 超商取貨門市挑選頁。 */
  pickupStorePicker: definePage({
    id: 'commerce.checkout.pickupStorePicker',
    loginNext: () => '/checkout',
    path: '/checkout/pickup/select',
    method: 'get',
    audience: 'customer',
    input: pickupStorePickerInput,
    contract: {
      kind: 'storefront', request: 'query', input: jsonSchema(['token']), audience: 'customer',
      responses: [html(200), html('platform-error'), redirectServerConstructed], cookieEffects: notice,
    },
    resolve: async (ctx, { token }) => {
      const view = await loadCartView(ctx);
      const profile = await ctx.queries.execute<{ id: string }>('commerce.customer.getMyProfile', {}, { actor: ctx.actor });
      // The view establishes the token binding before calling a provider. A token
      // cannot turn into an oracle for another cart's method or carrier stores.
      const selection = await ctx.queries.execute<any>('commerce.shipping.getPickupSelectionView', {
        token, cartId: view.cartId, customerId: profile.id, shippingMethodId: undefined,
      }, { actor: ctx.actor });
      const provider = ctx.providers.get<ShippingProvider>('shipping', selection.provider);
      if (!provider.pickupStores) throw PlatformError.validation('This shipping provider does not have a store picker');
      return {
        kind: 'view',
        view: {
          token, shippingMethodId: selection.shippingMethodId, expiresAt: selection.expiresAt,
          stores: [...await provider.pickupStores({ serviceType: selection.type })],
        } satisfies ThemePickupStorePickerView,
      };
    },
  }),

  /**
   * 開一次超商取貨門市挑選流程，轉址到挑選頁。
   */
  startPickupSelection: definePage({
    id: 'commerce.checkout.startPickupSelection',
    loginNext: () => '/checkout',
    path: '/checkout/pickup/start',
    method: 'post',
    audience: 'customer',
    required: false,
    input: startPickupSelectionInput,
    contract: {
      kind: 'storefront', request: 'form', input: jsonSchema(['cartId', 'shippingMethodId']), audience: 'customer',
      responses: [html('platform-error'), redirectServerConstructed], cookieEffects: notice,
    },
    resolve: async (ctx, { cartId, shippingMethodId }) => {
      const selection = await ctx.commands.execute<{ token: string }>('commerce.shipping.beginPickupSelection', {
        cartId, shippingMethodId,
      }, { actor: ctx.actor });
      return { kind: 'redirect', location: `/checkout/pickup/select?token=${encodeURIComponent(selection.token)}` };
    },
  }),

  /**
   * 送出訂單並立即排入付款工作，訂單頁呈現處理中的狀態。
   *
   * 冪等鍵是購物車識別碼，而它由表單帶回來：重送的請求若改問「現在的車」
   * 會問到一台新的空車。這是 Spec 0003 點名要修的缺陷——原本每次現產一個
   * 隨機值，等於完全沒有保護。
   */
  submit: definePage({
    id: 'commerce.checkout.submit',
    path: '/checkout',
    method: 'post',
    audience: 'customer',
    required: false,
    input: checkoutInput,
    contract: {
      kind: 'storefront', request: 'form', rateLimit: 'cart',
      input: jsonSchema([
        'cartId', 'shippingMethodId', 'pickupSelectionToken', 'pickupRecipient', 'pickupPhone', 'recipient', 'phone',
        'postcode', 'city', 'district', 'line1', 'line2', 'paymentProvider', 'paymentMethod', 'invoicePreference',
        'invoiceCarrierNumber', 'invoiceLoveCode',
      ]),
      audience: 'customer', responses: [html('platform-error'), redirectServerConstructed], cookieEffects: notice,
    },
    resolve: async (ctx, body) => {
      const cartId = body.cartId;
      const paymentProvider = ctx.providers.get<PaymentProvider>('payment', body.paymentProvider || undefined);
      const paymentMethod = paymentProvider.paymentMethods().find((method) => method.code === body.paymentMethod);
      if (!paymentMethod) {
        throw PlatformError.validation('請先選擇可用的付款方式');
      }
      const order = await ctx.commands.execute<{ id: string; number: string }>(
        'commerce.order.checkoutCart',
        {
          cartId,
          shippingMethodId: body.shippingMethodId,
          ...(body.pickupSelectionToken ? {
            pickupSelectionToken: body.pickupSelectionToken, pickupRecipient: body.pickupRecipient?.trim() ?? '', pickupPhone: body.pickupPhone?.trim() ?? '',
          } : { destination: {
            kind: 'taiwan_home', countryCode: 'TW', recipient: body.recipient?.trim() ?? '', phone: body.phone?.trim() ?? '',
            postcode: body.postcode?.trim() ?? '', city: body.city?.trim() ?? '', district: body.district?.trim() ?? '',
            line1: body.line1?.trim() ?? '', line2: body.line2?.trim() || null,
          } }),
          invoicePreference: invoicePreferenceFromForm(body),
        },
        // 鍵綁上身分：冪等鍵是猜得到的（購物車識別碼），而它決定了誰讀得到那份回應。
        { actor: ctx.actor, idempotencyKey: `cart:${ctx.actor.id}:${cartId}` },
      );
      await ctx.commands.execute('commerce.order.payOrder', {
        orderId: order.id,
        provider: paymentProvider.id,
        method: paymentMethod.code,
      }, {
        // `payOrder` locks the aggregate and refuses a second active attempt. This key is
        // deliberately per submission so a failed attempt can be retried from the order flow.
        actor: ctx.actor, idempotencyKey: `storefront-pay:${order.id}:${randomUUID()}`,
      });
      return { kind: 'redirect', location: `/orders/${order.number}` };
    },
  }),
} as const;

export type CartPages = typeof cartPages;
