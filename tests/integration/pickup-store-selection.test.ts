import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SESSION_COOKIE, createServer } from '@storeweave/api';
import { csrfTokenFor } from '@storeweave/identity';
import { defaultTheme } from '@storeweave/theme-default';
import {
  ADMIN_ACTOR, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

const logisticsSecrets = {
  ECPAY_LOGISTICS_MERCHANT_ID: 'test-logistics-merchant-id',
  ECPAY_LOGISTICS_HASH_KEY: 'test-logistics-hash-key',
  ECPAY_LOGISTICS_HASH_IV: 'test-logistics-hash-iv',
};

let h: TestHarness;
let app: NestFastifyApplication;
beforeAll(async () => {
  h = await createHarness({
    extensions: {
      'mock-payment': { autoApprove: true },
      'ecpay-logistics': {
        mode: 'fake', pickupServiceTypes: ['pickup'],
        pickupStores: [{ providerStoreId: 'STORE-1', storeName: '測試門市', storeAddress: '台北市測試路 1 號' }],
      },
    },
    secrets: logisticsSecrets,
  });
  app = await createServer({ runtime: h.runtime, theme: defaultTheme, release: { version: 'test', configPath: '<test>' } });
}, 300_000);
afterAll(async () => { await app?.close(); await h?.close(); });

const inject = (options: Parameters<NestFastifyApplication['inject']>[0]) => app.inject(options);

async function readyCart() {
  const customer = await createCustomer(h.runtime);
  const product = await createProduct(h.runtime, { priceCents: 1_000 });
  await stockUp(h.runtime, product.id, 10);
  await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 }, { actor: customer, idempotencyKey: randomUUID() });
  const cart = await h.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor: customer });
  const method = await h.runtime.commands.execute<{ id: string }>('commerce.shipping.createShippingMethod', {
    code: `pickup-${randomUUID().slice(0, 8)}`, name: '測試超商取貨', provider: 'ecpay-logistics', type: 'pickup',
    destinationKind: 'pickup_store', feeCents: 60, enabled: true,
  }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
  return { customer, cart, method };
}

describe('pickup store selection', () => {
  it('uses a provider-verified store once and freezes it on the order', async () => {
    const { customer, cart, method } = await readyCart();
    const started = await h.runtime.commands.execute<{ token: string }>('commerce.shipping.beginPickupSelection', {
      cartId: cart.id, shippingMethodId: method.id,
    }, { actor: customer, idempotencyKey: randomUUID() });
    await h.runtime.commands.execute('commerce.shipping.completePickupSelection', {
      token: started.token, providerStoreId: 'STORE-1',
    }, { actor: h.runtime.actorForRole('storefront'), idempotencyKey: randomUUID() });
    const order = await h.runtime.commands.execute<any>('commerce.order.checkoutCart', {
      cartId: cart.id, shippingMethodId: method.id, pickupSelectionToken: started.token,
      pickupRecipient: '取貨人', pickupPhone: '0912345678',
    }, { actor: customer, idempotencyKey: randomUUID() });
    expect(order.delivery.destination).toMatchObject({ kind: 'pickup_store', providerStoreId: 'STORE-1', storeName: '測試門市', storeAddress: '台北市測試路 1 號' });
    const replay = await h.runtime.commands.execute<any>('commerce.order.checkoutCart', {
      cartId: cart.id, shippingMethodId: method.id, pickupSelectionToken: started.token,
      pickupRecipient: '取貨人', pickupPhone: '0912345678',
    }, { actor: customer, idempotencyKey: randomUUID() });
    // Checkout itself is idempotent; its existing-order path does not attempt
    // to consume the capability again or create another destination snapshot.
    expect(replay.id).toBe(order.id);
  });

  it('rejects a wrong store and a selection token bound to another customer', async () => {
    const { customer, cart, method } = await readyCart();
    const started = await h.runtime.commands.execute<{ token: string }>('commerce.shipping.beginPickupSelection', {
      cartId: cart.id, shippingMethodId: method.id,
    }, { actor: customer, idempotencyKey: randomUUID() });
    await expect(h.runtime.commands.execute('commerce.shipping.completePickupSelection', {
      token: started.token, providerStoreId: 'NOT-A-STORE',
    }, { actor: h.runtime.actorForRole('storefront'), idempotencyKey: randomUUID() })).rejects.toThrow(/not available/);
    const stranger = await createCustomer(h.runtime);
    await expect(h.runtime.queries.execute('commerce.shipping.getPickupSelectionView', {
      token: started.token, cartId: cart.id, customerId: stranger.customerId, shippingMethodId: method.id,
    }, { actor: stranger })).rejects.toThrow(/Pickup selection/);
  });

  it('accepts a cookie-less picker callback once, replays it safely, and rejects another customer at the HTTP boundary', async () => {
    const register = async (email: string) => {
      const response = await inject({ method: 'POST', url: '/api/v1/customers/register', payload: { email, password: 'a-good-password' } });
      return response.cookies.find((cookie) => cookie.name === SESSION_COOKIE)!.value;
    };
    const method = await h.runtime.commands.execute<{ id: string }>('commerce.shipping.createShippingMethod', {
      code: `pickup-http-${randomUUID().slice(0, 8)}`, name: 'HTTP 超商取貨', provider: 'ecpay-logistics', type: 'pickup',
      destinationKind: 'pickup_store', feeCents: 60, enabled: true,
    }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    const cartFor = async (session: string, sku: string) => {
      const product = await createProduct(h.runtime, { sku, priceCents: 1_000 });
      await stockUp(h.runtime, product.id, 2);
      await inject({ method: 'POST', url: '/cart/items', cookies: { [SESSION_COOKIE]: session }, headers: { 'x-csrf-token': csrfTokenFor(session) }, payload: { productId: product.id, quantity: 1 } });
      const checkout = await inject({ method: 'GET', url: `/checkout?shippingMethodId=${method.id}`, cookies: { [SESSION_COOKIE]: session } });
      return /name="cartId" value="([^"]+)"/.exec(checkout.body)![1];
    };
    const owner = await register(`pickup-owner-${randomUUID()}@example.test`);
    const ownerCartId = await cartFor(owner, `PICKUP-OWNER-${randomUUID().slice(0, 8)}`);
    const started = await inject({
      method: 'POST', url: '/checkout/pickup/start', cookies: { [SESSION_COOKIE]: owner }, headers: { 'x-csrf-token': csrfTokenFor(owner) },
      payload: { cartId: ownerCartId, shippingMethodId: method.id },
    });
    const token = new URL(started.headers.location as string, 'http://localhost').searchParams.get('token')!;
    const callback = { method: 'POST' as const, url: '/checkout/pickup/callback', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ token, providerStoreId: 'STORE-1' }).toString() };

    const first = await inject(callback);
    const replay = await inject(callback);
    expect(first.statusCode).toBe(303);
    expect(replay.statusCode).toBe(303);
    expect(first.headers.location).toBe(`/checkout?pickupSelectionToken=${encodeURIComponent(token)}`);

    const stranger = await register(`pickup-stranger-${randomUUID()}@example.test`);
    await cartFor(stranger, `PICKUP-STRANGER-${randomUUID().slice(0, 8)}`);
    const denied = await inject({ method: 'GET', url: `/checkout?shippingMethodId=${method.id}&pickupSelectionToken=${encodeURIComponent(token)}`, cookies: { [SESSION_COOKIE]: stranger } });
    expect(denied.statusCode).toBe(404);
  });
});
