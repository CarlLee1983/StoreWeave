import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { createServer } from '@storeweave/api';
import { defaultTheme } from '@storeweave/theme-default';
import { ADMIN_ACTOR, createCustomer, createHarness, createProduct, placeOrder, stockUp, storefrontCheckoutForm, type TestHarness } from './helpers';
import { busHttpInput, describeHttpRoutes, HTTP_CONTRACT, type ComposedHttpContract, type HttpRouteCatalogCarrier, type StorefrontHttpContract } from '../../apps/api/src/http/contract';
import { httpAdapter as commerceHttpAdapter } from '../../apps/api/src/releases/commerce';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { IS_EXTERNAL_CALLBACK } from '../../apps/api/src/http/auth';
import { InventoryController } from '../../apps/api/src/controllers/inventory.controller';
import { HealthController } from '../../apps/api/src/controllers/health.controller';
import { CatalogController } from '../../apps/api/src/controllers/catalog.controller';
import { SystemController } from '../../apps/api/src/controllers/system.controller';
import { AnalyticsController } from '../../apps/api/src/controllers/analytics.controller';
import { RefundController } from '../../apps/api/src/controllers/refund.controller';
import { InvoiceController } from '../../apps/api/src/controllers/invoice.controller';
import { NotificationController } from '../../apps/api/src/controllers/notification.controller';
import { ShippingController } from '../../apps/api/src/controllers/shipping.controller';
import { OrderController } from '../../apps/api/src/controllers/order.controller';
import { PromotionController } from '../../apps/api/src/controllers/promotion.controller';
import { CouponController } from '../../apps/api/src/controllers/coupon.controller';
import { RmaController } from '../../apps/api/src/controllers/rma.controller';
import { LoyaltyController } from '../../apps/api/src/controllers/loyalty.controller';
import { ContentArticleController, ContentContactController } from '../../apps/api/src/controllers/content.controller';
import { CustomerController } from '../../apps/api/src/controllers/customer.controller';
import { CartController } from '../../apps/api/src/controllers/cart.controller';
import { ExtensionsController } from '../../apps/api/src/controllers/extensions.controller';
import { McpController } from '../../apps/api/src/mcp/mcp.controller';
import { StorefrontController } from '../../apps/api/src/storefront/storefront.controller';
import { zodToJsonSchema } from 'zod-to-json-schema';

const ADMIN_TOKEN = 'test-admin-token-abcdefghijklmnop';
const MCP_TOKEN = 'test-mcp-token-abcdefghijklmnop';
const RESTRICTED_MCP_TOKEN = 'test-restricted-mcp-token-abcdefghijklmnop';

let h: TestHarness;
let app: NestFastifyApplication;

beforeAll(async () => {
  h = await createHarness();
  // 直接把 token 設定注入 runtime，模擬 commerce.yaml 的 auth.tokens
  (h.runtime.config.auth.tokens as unknown[]).push(
    { name: 'admin', role: 'admin', secretRef: 'ADMIN_TOKEN' },
    { name: 'mcp', role: 'mcp', secretRef: 'MCP_TOKEN' },
    { name: 'mcp-restricted', role: 'readonly', secretRef: 'RESTRICTED_MCP_TOKEN' },
  );
  (h.runtime as { secrets: any }).secrets = {
    get: (n: string) => ({ ADMIN_TOKEN, MCP_TOKEN, RESTRICTED_MCP_TOKEN, DEMO_ERP_API_KEY: 'test-key' } as Record<string, string>)[n],
    has: (n: string) => Boolean(({ ADMIN_TOKEN, MCP_TOKEN, RESTRICTED_MCP_TOKEN, DEMO_ERP_API_KEY: 'k' } as Record<string, string>)[n]),
    listNames: () => [],
  };
  app = await createServer({
    runtime: h.runtime,
    theme: defaultTheme,
    release: { version: 'test', configPath: '<test>' },
  });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await h?.close();
});

function inject(options: Parameters<NestFastifyApplication['inject']>[0]) {
  return app.inject(options);
}

const auth = (token = ADMIN_TOKEN) => ({ authorization: `Bearer ${token}` });

describe('REST 介面', () => {
  it('retains exact selected Commerce route identities with MCP on and off', async () => {
    const catalog = app.getHttpAdapter().getInstance() as HttpRouteCatalogCarrier;
    expect(commerceHttpAdapter.controllers(h.runtime.config)).toHaveLength(24);
    expect(catalog.storeweaveHttpCatalog?.filter(route => !route.kind.startsWith('static-'))).toHaveLength(152);
    expect(catalog.storeweaveHttpCatalog?.filter(route => route.kind === 'static-theme-assets')).toHaveLength(1);

    const enabled = h.runtime.config.mcp.enabled;
    h.runtime.config.mcp.enabled = false;
    const withoutMcp = await createReleaseServer({ runtime: h.runtime, theme: defaultTheme,
      httpAdapter: commerceHttpAdapter, release: { version: 'test', configPath: '<test>' } });
    try {
      const withoutMcpCatalog = withoutMcp.getHttpAdapter().getInstance() as HttpRouteCatalogCarrier;
      expect(commerceHttpAdapter.controllers(h.runtime.config)).toHaveLength(23);
      expect(withoutMcpCatalog.storeweaveHttpCatalog?.filter(route => !route.kind.startsWith('static-'))).toHaveLength(150);
      expect(withoutMcpCatalog.storeweaveHttpCatalog?.filter(route => route.kind === 'static-theme-assets')).toHaveLength(1);
      expect(withoutMcpCatalog.storeweaveHttpCatalog?.some(route => route.path === '/mcp')).toBe(false);
    } finally {
      h.runtime.config.mcp.enabled = enabled;
      await withoutMcp.close();
    }
  });

  it('adds exactly one documented CORS preflight route for Commerce', async () => {
    const cors = h.runtime.config.http.cors;
    const savedOrigins = [...cors.allowedOrigins];
    const savedCredentials = cors.credentials;
    let corsApp: NestFastifyApplication | undefined;
    try {
      cors.allowedOrigins.splice(0, cors.allowedOrigins.length, 'https://console.example');
      cors.credentials = true;
      corsApp = await createReleaseServer({ runtime: h.runtime, theme: defaultTheme,
        httpAdapter: commerceHttpAdapter, release: { version: 'test', configPath: '<test>' } });
      const catalog = (corsApp.getHttpAdapter().getInstance() as HttpRouteCatalogCarrier).storeweaveHttpCatalog!;
      expect(catalog).toHaveLength(154);
      expect(catalog.filter(route => route.kind === 'cors-preflight')).toEqual([expect.objectContaining({
        method: 'OPTIONS', path: '*', automaticRoute: true, auth: 'unauthenticated', request: 'headers', rateLimit: null,
        policy: expect.objectContaining({ allowedOrigins: ['https://console.example'], credentials: true }),
      })]);
      const crossSiteAnonymousWrite = await corsApp.inject({ method: 'POST', url: '/cart/items', headers: {
        origin: 'https://console.example', 'content-type': 'application/x-www-form-urlencoded',
      }, payload: 'productId=00000000-0000-4000-8000-000000000000&quantity=1' });
      expect(crossSiteAnonymousWrite).toMatchObject({ statusCode: 403, headers: {
        'access-control-allow-origin': 'https://console.example', 'access-control-allow-credentials': 'true',
      } });
    } finally {
      cors.allowedOrigins.splice(0, cors.allowedOrigins.length, ...savedOrigins);
      cors.credentials = savedCredentials;
      await corsApp?.close();
    }
  });

  it('publishes the exact POST-only limiter buckets from the mounted contracts', () => {
    const catalog = app.getHttpAdapter().getInstance() as HttpRouteCatalogCarrier;
    const routes = catalog.storeweaveHttpCatalog!;
    expect(routes.every(route => Object.hasOwn(route, 'rateLimit') &&
      (route.rateLimit === null || route.rateLimit === 'auth' || route.rateLimit === 'coupon' || route.rateLimit === 'cart' || route.rateLimit === 'callback'))).toBe(true);
    const limited = routes
      .filter(route => route.rateLimit !== null)
      .map(route => `${route.rateLimit} ${route.method} ${route.path}`)
      .sort();
    expect(limited).toEqual([
      'auth POST /api/v1/auth/login',
      'auth POST /api/v1/customers/register',
      'auth POST /forgot-password',
      'auth POST /login',
      'auth POST /register',
      'auth POST /reset-password',
      'callback POST /callbacks/:kind/:providerId',
      'cart POST /api/v1/cart/checkout',
      'cart POST /api/v1/cart/items',
      'cart POST /api/v1/cart/rewards',
      'cart POST /cart/clear',
      'cart POST /cart/items',
      'cart POST /cart/items/:productId',
      'cart POST /cart/rewards',
      'cart POST /checkout',
      'cart POST /orders/:number/cancel',
      'cart POST /orders/:number/pay',
      'coupon POST /api/v1/cart/coupon',
      'coupon POST /cart/coupon',
    ]);
  });

  it('maps customer path ids for reads and mutations without accepting unknown body fields', async () => {
    const customer = await createCustomer(h.runtime, { email: 'http-mapped-customer@example.com' });
    const base = `/api/v1/customers/${customer.customerId}`;
    const get = await inject({ url: base, headers: auth() });
    expect(get.statusCode).toBe(200);
    expect(get.json().data.id).toBe(customer.customerId);
    const status = await inject({ method: 'POST', url: `${base}/status`, payload: { status: 'active' },
      headers: { ...auth(), 'idempotency-key': 'http-customer-status' } });
    expect(status.statusCode).toBe(201);
    expect(status.json().data.status).toBe('active');
    const invalid = await inject({ method: 'POST', url: `${base}/rewards`,
      payload: { amountCents: 100, reason: 'test', unknown: true },
      headers: { ...auth(), 'idempotency-key': 'http-customer-reward-unknown' } });
    expect(invalid.statusCode).toBe(400);
    expect(JSON.stringify(invalid.json().error.details)).toContain('unknown');
  });

  it('describes all migrated routes and rejects invalid query/date inputs', async () => {
    const routes = describeHttpRoutes(h.runtime, [InventoryController, CatalogController, SystemController, AnalyticsController,
      RefundController, InvoiceController, NotificationController, ShippingController,
      OrderController, PromotionController, CouponController, RmaController, LoyaltyController,
      ContentContactController, ContentArticleController, CustomerController, CartController]);
    expect(routes).toHaveLength(93);
    for (const route of routes) {
      expect(app.getHttpAdapter().getInstance().hasRoute({ method: route.method, url: route.path })).toBe(true);
    }
    for (const url of ['/api/v1/products?limits=1', '/api/v1/system/jobs/dead?limits=1',
      '/api/v1/analytics/sales-summary?from=not-a-date', '/api/v1/analytics/promotions?to=not-a-date',
      '/api/v1/analytics/partners?partnerCodes=wrong']) {
      const response = await inject({ url, headers: auth() });
      expect(response.statusCode, url).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    }
    const summary = await inject({ url: '/api/v1/analytics/sales-summary?from=2026-01-01&to=2026-01-31', headers: auth() });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().data.from).toBe('2026-01-01T00:00:00.000Z');
    expect(summary.json().data.to).toBe('2026-01-31T00:00:00.000Z');
  });

  it('documents composed registration/theme outputs and keeps trusted fields server-owned', async () => {
    const routes = describeHttpRoutes(h.runtime, [ContentArticleController, CustomerController]);
    const registration = routes.find(route => route.kind === 'composed' && route.path === '/api/v1/customers/register');
    if (!registration || registration.kind !== 'composed') throw new Error('Missing registration contract');
    expect(registration).toMatchObject({ auth: 'anonymous', status: 201, kind: 'composed' });
    expect(registration.output).toMatchObject({ properties: { data: { required: ['id', 'email', 'displayName', 'cartNotice'] } } });
    const keys = routes.find(route => route.kind === 'composed' && route.path === '/api/v1/content/articles/image-keys');
    if (!keys || keys.kind !== 'composed') throw new Error('Missing image-keys contract');
    expect(keys.input).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
    expect(keys.injected).toEqual(['limit']);
    expect((await inject({ url: keys.path })).statusCode).toBe(401);
    expect((await inject({ url: keys.path, headers: auth(MCP_TOKEN) })).statusCode).toBe(403);
    const response = await inject({ url: keys.path, headers: auth() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, data: { keys: defaultTheme.editorialImageKeys ?? [] } });
    const contract: ComposedHttpContract = { kind: 'composed', request: 'none', target: keys.target,
      injected: ['limit'], output: { type: 'object' } };
    expect(busHttpInput(contract, { limit: 999 }, {}, { limit: 1 })).toEqual({ limit: 1 });
    expect(() => busHttpInput(contract, { limit: 999 })).toThrow('Missing HTTP server value');
    expect(() => busHttpInput(contract, {}, {}, { limit: 1, extra: true })).toThrow('Undeclared HTTP server value');
  });

  it('documents cart-owned fields and server-derived checkout replay keys', () => {
    const routes = describeHttpRoutes(h.runtime, [CartController]);
    const add = routes.find(route => route.kind === 'composed' && route.path === '/api/v1/cart/items' && route.method === 'POST');
    if (!add || add.kind !== 'composed') throw new Error('Missing cart add contract');
    expect(add.input).toHaveProperty('properties.productId');
    expect(add.input).not.toHaveProperty('properties.guestToken');
    expect(add.injected).toEqual(['guestToken']);
    const remove = routes.find(route => route.path.endsWith('/:productId') && route.method === 'DELETE')!;
    if (remove.kind !== 'bus' && remove.kind !== 'composed') throw new Error('Missing cart remove contract');
    expect(remove.input).toMatchObject({ required: ['productId'], properties: { productId: { format: 'uuid' } } });
    const checkout = routes.find(route => route.path === '/api/v1/cart/checkout')!;
    if (checkout.kind !== 'bus' && checkout.kind !== 'composed') throw new Error('Missing cart checkout contract');
    expect(checkout).toMatchObject({ serverDefaulted: ['cartId'], idempotencyKey: 'server-derived', auth: 'session-or-anonymous' });
    expect(checkout.input).toHaveProperty('properties.cartId');
    expect('required' in checkout.input && checkout.input.required).not.toContain('cartId');
  });

  it('documents authenticated raw route guard errors', async () => {
    const routes = describeHttpRoutes(h.runtime, [HealthController]);
    expect(routes.find(route => route.path === '/health/dependencies')).toMatchObject({
      guardError: { statuses: [401], contentType: 'application/json' },
    });
    expect((await inject({ url: '/health/dependencies' })).statusCode).toBe(401);
  });

  it('composes body projection before legacy null handling', () => {
    const contract: ComposedHttpContract = {
      kind: 'composed', request: 'body', target: { kind: 'command', name: 'commerce.order.cancelOrder' },
      bodyFields: ['reason'], nullAsMissing: ['reason'], output: 'target',
    };
    expect(busHttpInput(contract, { reason: null })).toEqual({ reason: undefined });
  });

  it('rejects a hidden server default in a projected body contract', () => {
    const controller = class InvalidBodyContract {};
    Reflect.defineMetadata(PATH_METADATA, 'invalid-contract', controller);
    const handler = () => undefined;
    Reflect.defineMetadata(METHOD_METADATA, RequestMethod.POST, handler);
    Reflect.defineMetadata(PATH_METADATA, '', handler);
    Reflect.defineMetadata(HTTP_CONTRACT, {
      kind: 'composed', request: 'body', target: { kind: 'command', name: 'commerce.order.checkoutCart' },
      bodyFields: ['shippingMethodId'], serverDefaulted: ['cartId'], output: 'target',
    } satisfies ComposedHttpContract, handler);
    Object.defineProperty(controller.prototype, 'handle', { value: handler });
    expect(() => describeHttpRoutes(h.runtime, [controller])).toThrow('Invalid HTTP body mapping');
  });

  it('preserves the content REST lifecycle and explicit 200 mutation responses', async () => {
    const base = '/api/v1/content/articles';
    expect((await inject({ url: base })).statusCode).toBe(401);
    expect((await inject({ url: `${base}?limits=2`, headers: auth() })).statusCode).toBe(400);
    const created = await inject({ method: 'POST', url: base,
      headers: { ...auth(), 'idempotency-key': 'http-content-create' },
      payload: { kind: 'news', slug: 'http-content-lifecycle', title: 'HTTP Content' } });
    expect(created.statusCode).toBe(200);
    const id = created.json().data.id;
    const updated = await inject({ method: 'POST', url: `${base}/${id}`,
      headers: { ...auth(), 'idempotency-key': 'http-content-update' }, payload: { title: 'Updated Content' } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.title).toBe('Updated Content');
    for (const [action, status] of [['publish', 'published'], ['unpublish', 'draft']] as const) {
      const response = await inject({ method: 'POST', url: `${base}/${id}/${action}`,
        headers: { ...auth(), 'idempotency-key': `http-content-${action}` } });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.status).toBe(status);
    }
    expect((await inject({ url: `${base}/${id}`, headers: auth() })).json().data.id).toBe(id);
    const removed = await inject({ method: 'DELETE', url: `${base}/${id}`,
      headers: { ...auth(), 'idempotency-key': 'http-content-delete' } });
    expect(removed.statusCode).toBe(200);
    expect((await inject({ url: `${base}/${id}`, headers: auth() })).statusCode).toBe(404);
  });

  it('reads and handles contact messages through the mapped path id', async () => {
    const message = await h.runtime.commands.execute<{ id: string }>('commerce.content.submitContactMessage', {
      name: 'HTTP Visitor', email: 'http-visitor@example.com', subject: 'HTTP Inbox', message: 'A test message',
    }, { actor: ADMIN_ACTOR, idempotencyKey: 'http-contact-message' });
    const base = '/api/v1/content/contact-messages';
    const list = await inject({ url: `${base}?status=new`, headers: auth() });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.items.some((item: { id: string }) => item.id === message.id)).toBe(true);
    expect((await inject({ url: `${base}/${message.id}`, headers: auth() })).json().data.subject).toBe('HTTP Inbox');
    const handled = await inject({ method: 'POST', url: `${base}/${message.id}/handled`,
      headers: { ...auth(), 'idempotency-key': 'http-contact-handled' } });
    expect(handled.statusCode).toBe(200);
    expect(handled.json().data.status).toBe('handled');
  });

  it('keeps the descriptor cancellation default for a legacy null reason', async () => {
    const product = await createProduct(h.runtime, { sku: 'HTTP-CANCEL-DEFAULT' });
    await stockUp(h.runtime, product.id, 1);
    const order = await placeOrder(h.runtime, product.id);
    const response = await inject({ method: 'POST', url: `/api/v1/orders/${order.id}/cancel`,
      headers: { ...auth(), 'idempotency-key': 'http-cancel-null-reason' }, payload: { reason: null } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('cancelled');
    const records = await h.runtime.database.pool.query<{ payload: { reason: string } }>(
      "SELECT payload FROM platform_outbox WHERE event_name = 'commerce.order.cancelled.v1' AND payload->>'orderId' = $1", [order.id]);
    expect(records.rows[0]?.payload.reason).toBe('customer request');
  });

  it('preserves operations query conversions and rejects unknown write fields', async () => {
    expect((await inject({ url: '/api/v1/system/jobs/dead?limit=', headers: auth() })).statusCode).toBe(200);
    for (const path of ['/api/v1/invoices', '/api/v1/notification-deliveries']) {
      expect((await inject({ url: `${path}?limit=`, headers: auth() })).statusCode).toBe(400);
      expect((await inject({ url: `${path}?offset=`, headers: auth() })).statusCode).toBe(200);
    }
    const methods = await inject({ url: '/api/v1/shipping/methods?enabled=true', headers: auth() });
    expect(methods.statusCode).toBe(200);
    expect(methods.json().data.items.length).toBeGreaterThan(0);
    expect(methods.json().data.items.every((method: { enabled: boolean }) => method.enabled)).toBe(true);
    expect((await inject({ url: '/api/v1/shipping/methods?enabled=other', headers: auth() })).statusCode).toBe(400);
    for (const [url, payload] of [
      ['/api/v1/refunds/orders/00000000-0000-4000-8000-000000000000', { reason: 'refund', unknown: true }],
      ['/api/v1/shipping/shipments/00000000-0000-4000-8000-000000000000/stage', { status: 'shipped', unknown: true }],
    ] as const) {
      const response = await inject({ method: 'POST', url, payload,
        headers: { ...auth(), 'idempotency-key': 'operations-unknown-field' } });
      expect(response.statusCode).toBe(400);
      expect(JSON.stringify(response.json().error.details)).toContain('unknown');
    }
  });

  it('documents raw health routes without changing their wire format', async () => {
    expect(describeHttpRoutes(h.runtime, [HealthController])).toMatchObject([
      { kind: 'raw', path: '/health/live', auth: 'anonymous', statuses: [200] },
      { kind: 'raw', path: '/health/ready', auth: 'anonymous', statuses: [200, 503] },
      { kind: 'raw', path: '/health/dependencies', auth: 'bearer-or-session', statuses: [200, 503] },
    ]);
    const live = await inject({ url: '/health/live' });
    expect(live.json()).toMatchObject({ status: 'ok' });
    expect(live.json()).not.toHaveProperty('success');
  });

  it('Inventory transport documents the mounted Nest routes and descriptor output', () => {
    const routes = describeHttpRoutes(h.runtime, [InventoryController]);
    expect(routes.map(route => [route.method, route.path, route.status])).toEqual([
      ['POST', '/api/v1/inventory/adjust', 200], ['GET', '/api/v1/inventory', 200],
      ['GET', '/api/v1/inventory/:productId', 200],
    ]);
    for (const route of routes) {
      expect(app.getHttpAdapter().getInstance().hasRoute({ method: route.method, url: route.path })).toBe(true);
      expect(route.auth).toBe('bearer-or-session');
    }
    const stock = routes[2]!;
    const list = routes[1]!;
    if ((stock.kind !== 'bus' && stock.kind !== 'composed') || (list.kind !== 'bus' && list.kind !== 'composed')) {
      throw new Error('Unexpected non-Bus Inventory route');
    }
    expect(stock.output).toMatchObject({ properties: { data: { properties: {
      updatedAt: { type: 'string', format: 'date-time' },
    } } } });
    expect(list.queryEncoding).toEqual({ productIds: 'csv' });
    expect(() => describeHttpRoutes(h.runtime, [InventoryController, InventoryController])).toThrow('Duplicate HTTP route');
  });

  it('Inventory uses the declared CSV/path mapping, ISO output, and strict query boundary', async () => {
    const product = await createProduct(h.runtime, { sku: 'HTTP-CONTRACT-STOCK' });
    await stockUp(h.runtime, product.id, 4);
    const list = await inject({ url: `/api/v1/inventory?productIds=${product.id}&limit=1`, headers: auth() });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.items).toHaveLength(1);
    expect(list.json().data.items[0].productId).toBe(product.id);
    const get = await inject({ url: `/api/v1/inventory/${product.id}`, headers: auth() });
    expect(get.statusCode).toBe(200);
    expect(get.json().data.onHand).toBe(4);
    expect(new Date(get.json().data.updatedAt).toISOString()).toBe(get.json().data.updatedAt);
    for (const query of ['limits=1', 'productIds=bad-uuid', 'productIds=a&productIds=b', 'limit=0']) {
      const invalid = await inject({ url: `/api/v1/inventory?${query}`, headers: auth() });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('documents the three physical extension routes with only selected descriptor targets', async () => {
    const routes = describeHttpRoutes(h.runtime, [ExtensionsController]);
    expect(routes.map(route => [route.method, route.path, route.kind])).toEqual([
      ['GET', '/api/v1/extensions', 'direct'],
      ['POST', '/api/v1/extensions/:id/commands/:command', 'extension-command'],
      ['GET', '/api/v1/extensions/:id/queries/:query', 'extension-query'],
    ]);
    for (const route of routes) {
      expect(app.getHttpAdapter().getInstance().hasRoute({ method: route.method, url: route.path })).toBe(true);
    }
    const list = routes.find(route => route.kind === 'direct' && route.path === '/api/v1/extensions');
    const command = routes.find(route => route.kind === 'extension-command');
    const query = routes.find(route => route.kind === 'extension-query');
    if (!list || !command || !query || list.kind !== 'direct' || command.kind !== 'extension-command' || query.kind !== 'extension-query') {
      throw new Error('Missing extension wildcard contracts');
    }
    expect(list.output).toMatchObject({ properties: { data: { properties: { items: { items: {
      required: ['id', 'name', 'version', 'platformVersion', 'permissions', 'subscribedEvents', 'commands', 'queries', 'providers', 'mcpTools'],
    } } } } } });
    expect((await inject({ url: list.path, headers: auth() })).json()).toMatchObject({ success: true, data: {
      items: expect.arrayContaining([expect.objectContaining({
        id: 'demo-erp', name: 'Demo ERP Integration', version: '1.0.0', platformVersion: '^1.0.0',
        commands: ['ext.demo-erp.resendOrder'], queries: ['ext.demo-erp.listDeliveries', 'ext.demo-erp.inspectDeliveryPayload'],
      })]),
    } });
    expect(command.request).toBe('body');
    expect(query).toMatchObject({ request: 'query', queryExtras: 'drop-and-log-keys' });
    expect(command.targets.map(target => target.target.name)).toEqual(['ext.demo-erp.resendOrder']);
    expect(query.targets.map(target => target.target.name)).toEqual([
      'ext.demo-erp.listDeliveries', 'ext.demo-erp.inspectDeliveryPayload',
    ]);
    const registration = h.runtime.commands.get('ext.demo-erp.resendOrder');
    expect(command.targets[0]).toMatchObject({
      extensionId: 'demo-erp', target: { kind: 'command', name: registration.descriptor.name },
      owner: registration.owner, permission: registration.descriptor.permission, idempotency: registration.descriptor.idempotency,
      input: zodToJsonSchema(registration.descriptor.input as never, { target: 'jsonSchema7' }),
      output: { properties: { data: zodToJsonSchema(registration.descriptor.output as never, { target: 'jsonSchema7' }) } },
    });
    expect(query.targets.every(target => target.owner === 'demo-erp' && target.target.kind === 'query')).toBe(true);
  });

  it('rejects malformed extension descriptor registrations while cataloging', () => {
    const extension = h.runtime.extensions.find('demo-erp')!;
    const list = vi.spyOn(h.runtime.extensions, 'list');
    const command = extension.commands[0]!;
    const query = extension.queries[0]!;
    try {
      list.mockReturnValue([{ ...extension, commands: ['ext.demo-erp.missing'], queries: [] }]);
      expect(() => describeHttpRoutes(h.runtime, [ExtensionsController])).toThrow('Missing extension command registration');

      list.mockReturnValue([{ ...extension, commands: ['ext.other.resendOrder'], queries: [] }]);
      expect(() => describeHttpRoutes(h.runtime, [ExtensionsController])).toThrow('Invalid extension command namespace');

      list.mockReturnValue([{ ...extension, commands: [query], queries: [] }]);
      expect(() => describeHttpRoutes(h.runtime, [ExtensionsController])).toThrow('Invalid extension command kind');

      list.mockReturnValue([{ ...extension, commands: [command], queries: [] }]);
      const actual = h.runtime.commands.get(command);
      const get = vi.spyOn(h.runtime.commands, 'get').mockImplementation(name =>
        name === command ? { ...actual, owner: 'other-extension' } : actual,
      );
      try {
        expect(() => describeHttpRoutes(h.runtime, [ExtensionsController])).toThrow('Invalid extension command owner');
      } finally { get.mockRestore(); }
    } finally { list.mockRestore(); }
  });

  it('returns NOT_FOUND for correctly prefixed but unregistered extension Bus targets', async () => {
    for (const request of [
      { method: 'POST' as const, url: '/api/v1/extensions/demo-erp/commands/ext.demo-erp.missing', payload: {} },
      { method: 'GET' as const, url: '/api/v1/extensions/demo-erp/queries/ext.demo-erp.missing' },
    ]) {
      const response = await inject({ ...request, headers: auth() });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    }
  });

  it('沒有 token 會回 401，錯誤信封一致', async () => {
    const res = await inject({ method: 'GET', url: '/api/v1/products' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'UNAUTHENTICATED' } });
  });

  it('錯誤的 token 也是 401', async () => {
    const res = await inject({ method: 'GET', url: '/api/v1/products', headers: auth('wrong-token-value-x') });
    expect(res.statusCode).toBe(401);
  });

  it('探針端點不需要 token', async () => {
    // 負載平衡器與 systemd 只需要知道活著與可服務，不需要看見內部細節
    for (const path of ['/health/live', '/health/ready']) {
      const res = await inject({ method: 'GET', url: path });
      expect(res.statusCode).toBeLessThan(400);
    }
  });

  it('依賴健康需要授權，且不對外洩漏內部細節', async () => {
    const anonymous = await inject({ method: 'GET', url: '/health/dependencies' });
    expect(anonymous.statusCode).toBe(401);

    const authorized = await inject({ method: 'GET', url: '/health/dependencies', headers: auth() });
    expect(authorized.statusCode).toBeLessThan(400);
    expect(authorized.json().checks.some((c: { name: string }) => c.name === 'postgres')).toBe(true);
  });

  it('成功回應使用統一信封', async () => {
    const res = await inject({ method: 'GET', url: '/api/v1/products', headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.items)).toBe(true);
  });

  it('寫入端點缺 Idempotency-Key 會被拒', async () => {
    const res = await inject({
      method: 'POST', url: '/api/v1/inventory/adjust', headers: auth(),
      payload: { productId: '00000000-0000-4000-8000-000000000000', delta: 1, reason: 'restock' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('REST 與 Command Bus 走同一條路徑', async () => {
    const create = await inject({
      method: 'POST', url: '/api/v1/products',
      headers: { ...auth(), 'idempotency-key': 'http-create-1' },
      payload: { sku: 'HTTP-1', name: 'HTTP 商品', priceCents: 3300, currency: 'TWD', status: 'active' },
    });
    expect(create.statusCode).toBe(201);
    const productId = create.json().data.id;

    const viaBus = await h.runtime.queries.execute<any>('commerce.catalog.getProduct', { id: productId },
      { actor: { id: 'x', type: 'system', permissions: ['*'] } });
    expect(viaBus.sku).toBe('HTTP-1');
  });

  it('多帶一個不認得的欄位回 400，而不是 201 卻沒有套用它', async () => {
    // 拼錯的欄位名以前會被 Zod 安靜丟掉，端點回 201，送出者以為自己設了 status（ADR 0024）。
    const res = await inject({
      method: 'POST', url: '/api/v1/products',
      headers: { ...auth(), 'idempotency-key': 'http-strict-1' },
      payload: { sku: 'HTTP-STRICT', name: '嚴格輸入', priceCents: 100, statuss: 'draft' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    // 訊息裡沒有欄位名，因此 details 必須說得出是哪一個鍵——否則收到 400 的人不知道要拿掉什麼。
    expect(JSON.stringify(res.json().error.details)).toContain('statuss');

    const found = await inject({ method: 'GET', url: '/api/v1/products?q=HTTP-STRICT', headers: auth() });
    expect(found.json().data.items).toHaveLength(0);
  });

  it('Extension 的通用橋接只接受屬於該 Extension 的名稱', async () => {
    expect((await inject({ method: 'GET', url: '/api/v1/extensions/demo-erp/queries/ext.demo-erp.listDeliveries' })).statusCode).toBe(401);
    expect((await inject({ method: 'GET', url: '/api/v1/extensions/missing/queries/ext.missing.list', headers: auth() })).statusCode).toBe(404);
    expect((await inject({ method: 'GET', url: '/api/v1/extensions/demo-erp/queries/ext.demo-erp.listDeliveries', headers: auth(MCP_TOKEN) })).statusCode).toBe(403);
    const good = await inject({
      method: 'GET', url: '/api/v1/extensions/demo-erp/queries/ext.demo-erp.listDeliveries?limit=10', headers: auth(),
    });
    expect(good.statusCode).toBe(200);

    const bad = await inject({
      method: 'GET', url: '/api/v1/extensions/demo-erp/queries/commerce.catalog.searchProducts', headers: auth(),
    });
    expect(bad.statusCode).toBe(400);
  });

  it('橋接明挑欄位：query string 上的 cache-buster 不會撞上 strict 的輸入（工單 51）', async () => {
    // `_t=` 這種鍵是瀏覽器與前端加上去的，呼叫端阻止不了；在這裡回 400 等於把別人加的東西算到他頭上。
    const res = await inject({
      method: 'GET',
      url: '/api/v1/extensions/demo-erp/queries/ext.demo-erp.listDeliveries?limit=10&_t=1724371200000',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);

    // 宣告過的鍵必須活著穿過去。把所有鍵都挑掉的實作同樣會回 200（`limit` 有 default 50），
    // 因此這裡送一個違反 schema 的值：它必須抵達 schema 並被擋下。
    const passedThrough = await inject({
      method: 'GET', url: '/api/v1/extensions/demo-erp/queries/ext.demo-erp.listDeliveries?limit=0', headers: auth(),
    });
    expect(passedThrough.statusCode).toBe(400);
    expect(JSON.stringify(passedThrough.json().error.details)).toContain('limit');
  });

  it('挑掉的鍵會留下一行日誌，而不是靜靜消失（工單 51）', async () => {
    // 打錯的 `?limits=10` 拿到的是 200 帶預設值。沒有這行日誌，維運手上只有「它沒照我說的做」。
    const warn = vi.spyOn(h.runtime.logger, 'warn');
    try {
      const res = await inject({
        method: 'GET', url: '/api/v1/extensions/demo-erp/queries/ext.demo-erp.listDeliveries?limits=private-query-value', headers: auth(),
      });

      expect(res.statusCode).toBe(200);
      const fields = warn.mock.calls.find(([fields]) => JSON.stringify(fields).includes('limits'))?.[0];
      expect(fields).toMatchObject({ query: 'ext.demo-erp.listDeliveries', dropped: ['limits'] });
      expect(JSON.stringify(fields)).not.toContain('private-query-value');
    } finally {
      warn.mockRestore();
    }
  });

  it('但 Extension Command 的 body 多一個鍵仍然回 400（工單 51）', async () => {
    // body 裡多出來的鍵一定是呼叫端自己送的，那正是 ADR 0024 要讓它看得見的情況。
    const res = await inject({
      method: 'POST', url: '/api/v1/extensions/demo-erp/commands/ext.demo-erp.resendOrder',
      headers: { ...auth(), 'idempotency-key': 'ext-strict-1' },
      payload: { orderId: '11111111-1111-4111-8111-111111111111', notify: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.json().error.details)).toContain('notify');
  });

  it('契約自省列出 Command / Query / Event', async () => {
    const commands = await inject({ method: 'GET', url: '/api/v1/meta/commands', headers: auth() });
    const events = await inject({ method: 'GET', url: '/api/v1/meta/events', headers: auth() });
    expect(commands.json().data.items.map((c: any) => c.name)).toContain('commerce.order.payOrder');
    expect(events.json().data.items.map((e: any) => e.name)).toContain('commerce.order.paid.v2');
    expect(events.json().data.items[0].payload).toHaveProperty('type');
  });
});

describe('Storefront SSR', () => {
  it('catalogs all mounted storefront identities without inventing REST or Bus responses', () => {
    const routes = describeHttpRoutes(h.runtime, [StorefrontController]);
    expect(routes).toHaveLength(41);
    for (const route of routes) {
      expect(app.getHttpAdapter().getInstance().hasRoute({ method: route.method, url: route.path }), `${route.method} ${route.path}`).toBe(true);
    }
    const pages = routes.filter((route): route is Extract<typeof route, { kind: 'storefront' }> => route.kind === 'storefront');
    const asset = routes.find((route): route is Extract<typeof route, { kind: 'storefront-asset' }> => route.kind === 'storefront-asset');
    expect(pages).toHaveLength(40);
    expect(asset).toMatchObject({ method: 'GET', path: '/storefront-assets/:file', auth: 'session-or-anonymous',
      allowedFiles: expect.arrayContaining(['woven-day-hero.png']), success: { contentType: 'image/png', cacheControl: 'public, max-age=0' },
      notFound: { status: 404, contentType: 'application/json' }, guardError: { statuses: [401] } });
    expect(pages.filter(route => route.request === 'none')).toHaveLength(17);
    expect(pages.filter(route => route.request === 'query')).toHaveLength(8);
    expect(pages.filter(route => route.request === 'form')).toHaveLength(15);
    expect(pages.filter(route => route.auth === 'session-or-anonymous')).toHaveLength(30);
    expect(pages.filter(route => route.auth === 'anonymous')).toHaveLength(9);
    expect(pages.filter(route => route.auth === 'opaque-capability')).toHaveLength(1);
    expect(pages.filter(route => route.responses.every(response => response.kind === 'html'))).toHaveLength(17);
    expect(pages.filter(route => route.responses.some(response => response.kind === 'html') && route.responses.some(response => response.kind === 'redirect'))).toHaveLength(22);
    expect(pages.filter(route => route.responses.every(response => response.kind === 'redirect'))).toHaveLength(1);
    const root = pages.find(route => route.path === '/')!;
    const pay = pages.find(route => route.path === '/orders/:number/pay')!;
    const login = pages.find(route => route.path === '/login')!;
    const pickup = pages.find(route => route.path === '/checkout/pickup/callback')!;
    const rewards = pages.find(route => route.path === '/cart/rewards')!;
    const logout = pages.find(route => route.path === '/logout')!;
    expect(root).toMatchObject({ request: 'query', csrf: 'none', guardError: { statuses: [401], contentType: 'application/json' },
      responses: [{ kind: 'html', status: 200 }, { kind: 'html', status: 'platform-error' }] });
    expect(pay).toMatchObject({ request: 'form', params: { number: 'number' }, audience: 'customer', csrf: 'session-csrf-or-same-origin', parserError: { statuses: [400, 413] } });
    expect(login).toMatchObject({ request: 'query', auth: 'anonymous', csrf: 'none', cookieEffects: [] });
    expect(pickup).toMatchObject({ request: 'form', auth: 'opaque-capability', csrf: 'none', guardError: null, parserError: { statuses: [400, 413] } });
    expect(rewards).toMatchObject({ audience: 'customer', responses: [
      { kind: 'html', status: 'platform-error' },
      { kind: 'redirect', status: 303, location: { kind: 'fixed', value: '/cart' } },
      { kind: 'redirect', status: 303, location: { kind: 'fixed', value: '/login?next=%2Fcart' } },
    ] });
    expect(logout).toMatchObject({ request: 'none', auth: 'anonymous', csrf: 'same-origin', cookieEffects: ['session-clear'], responses: [{ kind: 'redirect', status: 303, location: { kind: 'fixed', value: '/' } }] });
    expect(pages.every(route => !('target' in route))).toBe(true);

    const controller = class InvalidOpaqueStorefrontContract {};
    Reflect.defineMetadata(PATH_METADATA, 'invalid-opaque-storefront', controller);
    const handler = () => undefined;
    Reflect.defineMetadata(METHOD_METADATA, RequestMethod.POST, handler);
    Reflect.defineMetadata(PATH_METADATA, '', handler);
    Reflect.defineMetadata(HTTP_CONTRACT, {
      kind: 'storefront', request: 'form', auth: 'opaque-capability', input: { type: 'object', properties: {}, additionalProperties: true },
      responses: [{ kind: 'redirect', status: 303, location: { kind: 'fixed', value: '/' } }],
    } satisfies StorefrontHttpContract, handler);
    Object.defineProperty(controller.prototype, 'handle', { value: handler });
    expect(() => describeHttpRoutes(h.runtime, [controller])).toThrow('Invalid storefront opaque capability');
    Reflect.defineMetadata(IS_EXTERNAL_CALLBACK, true, handler);
    expect(describeHttpRoutes(h.runtime, [controller])[0]).toMatchObject({ auth: 'opaque-capability', guardError: null });

    const missingPathField = class MissingStorefrontPathField {};
    Reflect.defineMetadata(PATH_METADATA, 'missing-storefront-path-field/:id', missingPathField);
    const missingHandler = () => undefined;
    Reflect.defineMetadata(METHOD_METADATA, RequestMethod.POST, missingHandler);
    Reflect.defineMetadata(PATH_METADATA, '', missingHandler);
    Reflect.defineMetadata(HTTP_CONTRACT, {
      kind: 'storefront', request: 'form', input: { type: 'object', properties: {}, additionalProperties: true }, params: { id: 'id' },
      responses: [{ kind: 'redirect', status: 303, location: { kind: 'fixed', value: '/' } }],
    } satisfies StorefrontHttpContract, missingHandler);
    Object.defineProperty(missingPathField.prototype, 'handle', { value: missingHandler });
    expect(() => describeHttpRoutes(h.runtime, [missingPathField])).toThrow('Invalid storefront parameter mapping');
  });

  it('keeps public GET guard and Theme errors on their separate transports', async () => {
    const invalidBearer = await inject({ url: '/', headers: { authorization: 'Bearer not-a-real-token' } });
    expect(invalidBearer.statusCode).toBe(401);
    expect(invalidBearer.headers['content-type']).toContain('application/json');
    expect(invalidBearer.json()).toMatchObject({ success: false, error: { code: 'UNAUTHENTICATED' } });

    const invalidPage = await inject({ url: '/?page=0' });
    expect(invalidPage.statusCode).toBe(400);
    expect(invalidPage.headers['content-type']).toContain('text/html');
    expect(invalidPage.body).toContain('400');
  });

  it('normalizes auth redirects, rejects cross-origin forms before commands, and clears a storefront session', async () => {
    const login = await inject({ url: '/login?next=https%3A%2F%2Fevil.example%2Fsteal' });
    expect(login.statusCode).toBe(200);
    expect(login.headers['content-type']).toContain('text/html');
    expect(login.body).toContain('name="next" value="/"');
    expect(login.body).not.toContain('evil.example');

    const execute = vi.spyOn(h.runtime.commands, 'execute');
    try {
      const crossOrigin = await inject({ method: 'POST', url: '/cart/items', headers: {
        origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded',
      }, payload: 'productId=00000000-0000-4000-8000-000000000000&quantity=1' });
      expect(crossOrigin.statusCode).toBe(403);
      expect(crossOrigin.headers['content-type']).toContain('application/json');
      expect(crossOrigin.json()).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
      expect(execute).not.toHaveBeenCalled();
    } finally { execute.mockRestore(); }

    const registered = await inject({ method: 'POST', url: '/register', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `email=logout-${Date.now()}%40example.test&password=a-good-password&next=%2F` });
    const session = registered.cookies.find(cookie => cookie.name === 'commerce_session')!.value;
    const logout = await inject({ method: 'POST', url: '/logout', cookies: { commerce_session: session } });
    expect(logout.statusCode).toBe(303);
    expect(logout.headers.location).toBe('/');
    expect(logout.cookies.find(cookie => cookie.name === 'commerce_session')?.value).toBe('');
  });

  it('renders pickup callback command errors as Theme HTML without CSRF capability validation', async () => {
    const response = await inject({ method: 'POST', url: '/checkout/pickup/callback', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'token=not-a-pickup-token&providerStoreId=STORE-1' });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('400');
  });

  it('首頁輸出 Theme 產生的 HTML', async () => {
    const product = await createProduct(h.runtime, { sku: 'SSR-1', name: 'SSR 商品' });
    await stockUp(h.runtime, product.id, 3);
    const res = await inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('SSR 商品');
    expect(res.body).toContain('Test Store');
  });

  it('公開型錄保留搜尋與分頁 query，只呈現 active 商品', async () => {
    const tag = `SSR-DISC-${Date.now()}`;
    for (let index = 0; index < 25; index += 1) {
      await createProduct(h.runtime, { sku: `${tag}-${index}`, name: `${tag} 商品 ${index}`, priceCents: 1_000 });
    }
    await createProduct(h.runtime, { sku: `${tag}-EXPENSIVE`, name: `${tag} 高價商品`, priceCents: 100_000 });
    const archived = await createProduct(h.runtime, { sku: `${tag}-ARCHIVED`, name: `${tag} 已封存`, status: 'archived' });

    const first = await inject({ method: 'GET', url: `/?q=${encodeURIComponent(tag)}&minPrice=0&maxPrice=10&page=1` });
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain(`${tag} 商品 0`);
    expect(first.body).not.toContain(`${tag} 已封存`);
    expect(first.body).toContain(`href="/?q=${tag}&amp;minPrice=0&amp;maxPrice=10&amp;page=2"`);
    expect(first.body).toContain('rel="next"');

    const second = await inject({ method: 'GET', url: `/?q=${encodeURIComponent(tag)}&minPrice=0&maxPrice=10&page=2` });
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain(`${tag} 商品 24`);
    expect(second.body).toContain(`href="/?q=${tag}&amp;minPrice=0&amp;maxPrice=10"`);
    expect(second.body).toContain('rel="prev"');

    const priceFiltered = await inject({ method: 'GET', url: `/?q=${encodeURIComponent(tag)}&minPrice=500` });
    expect(priceFiltered.statusCode).toBe(200);
    expect(priceFiltered.body).toContain(`${tag} 高價商品`);
    expect(priceFiltered.body).not.toContain(`${tag} 商品 0`);

    const inclusiveBounds = await inject({ method: 'GET', url: `/?q=${encodeURIComponent(tag)}&minPrice=10&maxPrice=10` });
    expect(inclusiveBounds.statusCode).toBe(200);
    expect(inclusiveBounds.body).toContain(`${tag} 商品 0`);
    expect(inclusiveBounds.body).not.toContain(`${tag} 高價商品`);

    const maxOnly = await inject({ method: 'GET', url: `/?q=${encodeURIComponent(tag)}&maxPrice=10` });
    expect(maxOnly.statusCode).toBe(200);
    expect(maxOnly.body).toContain(`${tag} 商品 0`);
    expect(maxOnly.body).not.toContain(`${tag} 高價商品`);

    const apiFiltered = await inject({
      method: 'GET',
      url: `/api/v1/products?q=${encodeURIComponent(tag)}&minPriceCents=50000`,
      headers: auth(),
    });
    expect(apiFiltered.statusCode).toBe(200);
    expect(apiFiltered.json().data.items.map((item: { name: string }) => item.name)).toContain(`${tag} 高價商品`);
    expect(apiFiltered.json().data.items.map((item: { name: string }) => item.name)).not.toContain(`${tag} 商品 0`);

    const invalidPage = await inject({ method: 'GET', url: '/?page=0' });
    expect(invalidPage.statusCode).toBe(400);
    expect(invalidPage.headers['content-type']).toContain('text/html');

    const invalidRange = await inject({ method: 'GET', url: '/?minPrice=20&maxPrice=10' });
    expect(invalidRange.statusCode).toBe(400);
    const invalidPrice = await inject({ method: 'GET', url: '/?minPrice=1.5' });
    expect(invalidPrice.statusCode).toBe(400);

    const hiddenDetail = await inject({ method: 'GET', url: `/p/${archived.id}` });
    expect(hiddenDetail.statusCode).toBe(404);
  });

  it('登入後的商品頁帶著 CSRF 隱藏欄位，未登入則沒有', async () => {
    const product = await createProduct(h.runtime, { sku: 'SSR-CSRF', name: 'CSRF 測試' });
    await stockUp(h.runtime, product.id, 1);

    const anonymous = await inject({ method: 'GET', url: `/p/${product.id}` });
    expect(anonymous.body).not.toContain('name="_csrf"');
    expect(anonymous.body).toContain('加入購物車');

    const registered = await inject({
      method: 'POST', url: '/register',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=csrf%40example.com&password=a-good-password&next=%2F',
    });
    const session = registered.cookies.find((c) => c.name === 'commerce_session')!.value;

    const signedIn = await inject({ method: 'GET', url: `/p/${product.id}`, cookies: { commerce_session: session } });
    expect(signedIn.body).toContain('name="_csrf"');
    expect(signedIn.body).toContain('加入購物車');
  });

  it('商品頁包含加入購物車的表單', async () => {
    const product = await createProduct(h.runtime, { sku: 'SSR-2', name: '結帳測試' });
    await stockUp(h.runtime, product.id, 2);
    const res = await inject({ method: 'GET', url: `/p/${product.id}` });
    expect(res.body).toContain('action="/cart/items"');
    expect(res.body).toContain('結帳測試');
  });

  it('不存在的商品回 404 的 Theme 錯誤頁', async () => {
    const res = await inject({ method: 'GET', url: '/p/00000000-0000-4000-8000-000000000000' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('404');
  });

  it('未登入結帳會被導去登入頁，而不是建出一張沒有歸屬的訂單', async () => {
    const product = await createProduct(h.runtime, { sku: 'SSR-GUEST', name: '訪客結帳', priceCents: 1500 });
    await stockUp(h.runtime, product.id, 5);

    const res = await inject({
      method: 'POST', url: '/checkout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `productId=${product.id}&quantity=1`,
    });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(/^\/login\?next=/);
  });

  it('註冊完可以直接結帳，訂單建立後導向訂單頁', async () => {
    const product = await createProduct(h.runtime, { sku: 'SSR-3', name: '下單測試', priceCents: 1500 });
    await stockUp(h.runtime, product.id, 5);

    const registered = await inject({
      method: 'POST', url: '/register',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=ssr%40example.com&password=a-good-password&next=%2F',
    });
    expect(registered.statusCode).toBe(303);
    const session = registered.cookies.find((c) => c.name === 'commerce_session')!.value;

    // 表單的 CSRF token 由商品頁渲染出來，這裡照瀏覽器的做法把它抓下來再送
    const page = await inject({ method: 'GET', url: `/p/${product.id}`, cookies: { commerce_session: session } });
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1];
    const form = (body: string) => ({
      headers: { 'content-type': 'application/x-www-form-urlencoded' as const },
      cookies: { commerce_session: session },
      payload: `${body}&_csrf=${encodeURIComponent(csrf)}`,
    });

    await inject({ method: 'POST', url: '/cart/items', ...form(`productId=${product.id}&quantity=2`) });
    const confirm = await inject({ method: 'GET', url: '/checkout', cookies: { commerce_session: session } });
    const cartId = /name="cartId" value="([^"]+)"/.exec(confirm.body)![1];

    const res = await inject({ method: 'POST', url: '/checkout', ...form(storefrontCheckoutForm(h, cartId)) });
    expect(res.statusCode).toBe(303);
    const location = res.headers.location as string;
    const orderPage = await inject({ method: 'GET', url: location, cookies: { commerce_session: session } });
    expect(orderPage.body).toContain('payment_processing');
    expect(orderPage.body).toContain('付款處理中');
    expect(orderPage.body).toContain('ssr@example.com');
  });
});

describe('MCP 介面', () => {
  const rpc = (body: unknown, token = MCP_TOKEN) =>
    inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${token}` }, payload: body as never });

  it('catalogs exactly the mounted direct and JSON-RPC routes from selected tool registrations', () => {
    const routes = describeHttpRoutes(h.runtime, [McpController]);
    expect(routes.map(route => [route.method, route.path, route.kind, route.kind === 'mcp' ? route.transport : null])).toEqual([
      ['GET', '/mcp', 'mcp', 'direct'],
      ['POST', '/mcp', 'mcp', 'jsonrpc'],
    ]);
    for (const route of routes) {
      expect(route.auth).toBe('bearer-or-session');
      expect(app.getHttpAdapter().getInstance().hasRoute({ method: route.method, url: route.path })).toBe(true);
      if (route.kind !== 'mcp') throw new Error('Missing MCP contract');
      expect(route.contentType).toBe('application/json');
      expect(route.protocolVersion).toBe('2025-06-18');
      expect(route.methods).toEqual(['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call']);
      expect(route.error).toHaveProperty('properties.error');
      expect(route.output).toHaveProperty(route.transport === 'jsonrpc' ? 'anyOf' : 'properties');
    }
    const post = routes.find(route => route.method === 'POST');
    if (!post || post.kind !== 'mcp') throw new Error('Missing MCP JSON-RPC contract');
    const registration = h.runtime.mcpTools.get('adjust_inventory');
    const target = h.runtime.commands.get(registration.definition.target.name);
    const tool = post.tools.find(tool => tool.name === registration.definition.name);
    expect(tool).toMatchObject({
      name: registration.definition.name, description: registration.definition.description, owner: registration.owner,
      target: registration.definition.target, targetOwner: target.owner, permission: target.descriptor.permission,
      idempotencyKey: 'tool-argument', input: zodToJsonSchema(registration.definition.input as never, { target: 'jsonSchema7' }),
    });
    expect(registration.owner).not.toBe(target.owner);
    expect(tool).not.toHaveProperty('output');
    expect(post.tools.find(tool => tool.name === 'search_products')).toMatchObject({ idempotencyKey: 'none' });
    expect((post.output as { anyOf?: Array<{ required?: string[] }> }).anyOf?.some(variant => variant.required?.includes('result'))).toBe(true);
    const get = routes.find(route => route.method === 'GET');
    if (!get || get.kind !== 'mcp') throw new Error('Missing MCP direct contract');
    expect(get.output).toMatchObject({ properties: { data: { properties: { tools: { items: { properties: { target: {
      required: ['kind', 'name'],
    } } } } } } } });
  });

  it('requires bearer-or-session, retains session CSRF, and returns JSON from both credential paths', async () => {
    const body = { jsonrpc: '2.0', id: 10, method: 'ping' };
    const missingAuth = await inject({ method: 'POST', url: '/mcp', payload: body });
    expect(missingAuth.statusCode).toBe(401);
    expect(missingAuth.headers['content-type']).toContain('application/json');
    expect(missingAuth.json()).toMatchObject({ success: false, error: { code: 'UNAUTHENTICATED' } });
    expect(missingAuth.json()).not.toHaveProperty('jsonrpc');
    expect(missingAuth.json()).not.toHaveProperty('result');

    const email = 'mcp-session@example.com';
    const password = 'mcp session password';
    await h.runtime.commands.execute('platform.identity.createUser', { email, password, displayName: 'MCP session', role: 'admin' }, {
      actor: ADMIN_ACTOR, idempotencyKey: 'mcp-session-user',
    });
    const login = await inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
    const session = login.cookies.find(cookie => cookie.name === 'commerce_session')!.value;
    const csrf = login.cookies.find(cookie => cookie.name === 'commerce_csrf')!.value;
    const csrfRejected = await inject({ method: 'POST', url: '/mcp', cookies: { commerce_session: session }, payload: body });
    expect(csrfRejected.statusCode).toBe(403);
    expect(csrfRejected.headers['content-type']).toContain('application/json');
    expect(csrfRejected.json()).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    expect(csrfRejected.json()).not.toHaveProperty('jsonrpc');
    expect(csrfRejected.json()).not.toHaveProperty('result');
    const sessionResponse = await inject({ method: 'POST', url: '/mcp', cookies: { commerce_session: session, commerce_csrf: csrf },
      headers: { 'x-csrf-token': csrf }, payload: body });
    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.headers['content-type']).toContain('application/json');
    expect(sessionResponse.json().result).toEqual({});
    const bearerResponse = await rpc(body);
    expect(bearerResponse.statusCode).toBe(200);
    expect(bearerResponse.headers['content-type']).toContain('application/json');
  });

  it('keeps both routes and reports empty tools when MCP selection is empty', async () => {
    const list = vi.spyOn(h.runtime.mcpTools, 'list').mockReturnValue([]);
    try {
      const routes = describeHttpRoutes(h.runtime, [McpController]);
      expect(routes).toHaveLength(2);
      expect(routes.every(route => route.kind === 'mcp' && route.tools.length === 0)).toBe(true);
      expect((await inject({ url: '/mcp', headers: auth() })).json().data.tools).toEqual([]);
      expect((await rpc({ jsonrpc: '2.0', id: 11, method: 'tools/list' })).json().result.tools).toEqual([]);
    } finally { list.mockRestore(); }
  });

  it('rejects a selected MCP tool whose matching Bus target is absent while cataloging', () => {
    const selected = h.runtime.mcpTools.get('search_products');
    const list = vi.spyOn(h.runtime.mcpTools, 'list').mockReturnValue([{
      ...selected,
      definition: { ...selected.definition, target: { kind: 'query', name: 'commerce.catalog.missing' } },
    }]);
    try {
      expect(() => describeHttpRoutes(h.runtime, [McpController]))
        .toThrow('Missing MCP query target: commerce.catalog.missing');
    } finally { list.mockRestore(); }
  });

  it('tools/list 只公開設定啟用的工具', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.statusCode).toBe(200);
    const names = res.json().result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['adjust_inventory', 'get_order', 'get_sales_summary', 'search_products']);
    expect(res.json().result.tools[0].inputSchema).toHaveProperty('type');
  });

  it('未知方法回 JSON-RPC error', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'nope' });
    expect(res.statusCode).toBe(200);
    expect(res.json().error.code).toBe(-32601);
  });

  it('keeps invalid requests and notifications in the JSON-RPC response contract', async () => {
    const invalid = await rpc({ jsonrpc: '1.0', id: 12, method: 'ping' });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });
    const notification = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notification.statusCode).toBe(200);
    expect(notification.json()).toEqual({ jsonrpc: '2.0', id: null, result: {} });
  });

  it('keeps unexpected tool failures as HTTP 200 JSON-RPC internal errors', async () => {
    const get = vi.spyOn(h.runtime.mcpTools, 'get').mockImplementation(() => { throw new Error('unexpected MCP failure'); });
    try {
      const response = await rpc({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'search_products', arguments: {} } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ jsonrpc: '2.0', id: 13, error: { code: -32603 } });
    } finally { get.mockRestore(); }
  });

  it('MCP 執行的寫入會經過 Command Bus 的權限與 Idempotency 檢查', async () => {
    const product = await createProduct(h.runtime, { sku: 'MCP-1' });
    const call = (args: Record<string, unknown>) =>
      rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'adjust_inventory', arguments: args } });

    const missingKey = await call({ productId: product.id, delta: 5, reason: 'restock' });
    expect(missingKey.json().result.isError).toBe(true);

    const execute = vi.spyOn(h.runtime.commands, 'execute');
    const ok = await call({ productId: product.id, delta: 5, reason: 'restock', idempotencyKey: 'mcp-key-1' });
    try {
      expect(ok.statusCode).toBe(200);
      expect(ok.json().result.structuredContent.onHand).toBe(5);
      expect(execute).toHaveBeenLastCalledWith('commerce.inventory.adjustStock',
        expect.not.objectContaining({ idempotencyKey: expect.anything() }),
        expect.objectContaining({ idempotencyKey: 'mcp-key-1', channel: 'mcp' }));
    } finally { execute.mockRestore(); }

    const replay = await call({ productId: product.id, delta: 5, reason: 'restock', idempotencyKey: 'mcp-key-1' });
    expect(replay.json().result.structuredContent.onHand).toBe(5);
  });

  it('MCP token 的角色限制了它能做什麼', async () => {
    const res = await rpc({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'get_order', arguments: { orderNumber: 'NOPE-1' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.isError).toBe(true);
    expect(res.json().result.content[0].text).toContain('NOT_FOUND');
  });

  it('keeps Bus permission failures inside a JSON-RPC tool result', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {
      name: 'get_sales_summary', arguments: {},
    } }, RESTRICTED_MCP_TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({ isError: true });
    expect(res.json().result.content[0].text).toContain('FORBIDDEN');
  });

  it('MCP 讀取工具回傳的是 DTO，不是資料表列', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'search_products', arguments: { query: 'MCP-1' } } });
    const item = res.json().result.structuredContent.items[0];
    expect(item).toHaveProperty('priceCents');
    expect(item).not.toHaveProperty('price_cents');
  });
});

describe('死信佇列 HTTP 端點', () => {
  it('未帶 token 會被擋', async () => {
    const res = await inject({ method: 'GET', url: '/api/v1/system/jobs/dead' });
    expect(res.statusCode).toBe(401);
  });

  it('admin token 可以列出死信工作', async () => {
    const res = await inject({
      method: 'GET',
      url: '/api/v1/system/jobs/dead',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toMatchObject({ items: expect.any(Array), total: expect.any(Number) });
  });

  it('重送需要 idempotency key', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/v1/system/jobs/dead/00000000-0000-4000-8000-000000000000/retry',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('工單 69：發票的 HTTP 營運介面', () => {
  const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };

  it('lists invoices for an operator token', async () => {
    const res = await inject({ method: 'GET', url: '/api/v1/invoices?limit=5', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toMatchObject({ items: expect.any(Array), total: expect.any(Number) });
  });

  it('does not expose the invoice queue or its retries to a token without invoice permissions', async () => {
    const mcp = { authorization: `Bearer ${MCP_TOKEN}` };
    expect((await inject({ method: 'GET', url: '/api/v1/invoices', headers: mcp })).statusCode).toBe(403);
    const retry = await inject({ method: 'POST', url: '/api/v1/invoices/00000000-0000-4000-8000-000000000000/retry-issue', headers: mcp, payload: {} });
    expect(retry.statusCode).toBe(403);
  });

  it('reports a missing invoice as 404 rather than an empty record', async () => {
    const res = await inject({ method: 'GET', url: '/api/v1/invoices/00000000-0000-4000-8000-000000000000', headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it('refuses an anonymous read of the invoice queue', async () => {
    expect((await inject({ method: 'GET', url: '/api/v1/invoices' })).statusCode).toBe(401);
  });
});

describe('工單 72：會員等級與購物金設定的營運介面', () => {
  const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const mcp = { authorization: `Bearer ${MCP_TOKEN}` };

  it('讀得到購物金設定，並且改得動累積比例', async () => {
    const before = await inject({ method: 'GET', url: '/api/v1/loyalty/settings', headers: auth });
    expect(before.statusCode).toBe(200);
    expect(JSON.parse(before.body).data).toMatchObject({ accrualBasisPoints: expect.any(Number), effectiveAfterDays: expect.any(Number) });

    const original = JSON.parse(before.body).data.accrualBasisPoints;
    const patched = await inject({ method: 'PATCH', url: '/api/v1/loyalty/settings', headers: auth, payload: { accrualBasisPoints: 250 } });
    expect(patched.statusCode).toBe(200);
    expect(JSON.parse(patched.body).data.accrualBasisPoints).toBe(250);
    expect(JSON.parse((await inject({ method: 'GET', url: '/api/v1/loyalty/settings', headers: auth })).body).data.accrualBasisPoints).toBe(250);
    // 設定是全域單例：留著 2.5% 會讓日後加進這個檔案的結帳測試拿到一個沒人預期的數字。
    await inject({ method: 'PATCH', url: '/api/v1/loyalty/settings', headers: auth, payload: { accrualBasisPoints: original } });
  });

  it('等級可以新增、修改與移除，同名視為修改而不是再開一級', async () => {
    const created = await inject({ method: 'PUT', url: '/api/v1/loyalty/tiers', headers: auth, payload: { name: 'ops-gold', thresholdPoints: 5000, multiplierBasisPoints: 15000 } });
    expect(created.statusCode).toBe(200);
    await inject({ method: 'PUT', url: '/api/v1/loyalty/tiers', headers: auth, payload: { name: 'ops-gold', thresholdPoints: 6000, multiplierBasisPoints: 15000 } });
    const listed = JSON.parse((await inject({ method: 'GET', url: '/api/v1/loyalty/tiers', headers: auth })).body).data.items;
    expect(listed.filter((tier: any) => tier.name === 'ops-gold')).toEqual([{ name: 'ops-gold', thresholdPoints: 6000, multiplierBasisPoints: 15000 }]);

    const removed = await inject({ method: 'DELETE', url: '/api/v1/loyalty/tiers/ops-gold', headers: auth });
    expect(removed.statusCode).toBe(200);
    expect(JSON.parse(removed.body).data.items.some((tier: any) => tier.name === 'ops-gold')).toBe(false);
  });

  // 這幾級由 migration 種下（一般會員／銀卡／金卡），不是測試自己建的。
  it('保底那一級移不掉：沒有門檻為零的等級，新會員不屬於任何等級', async () => {
    const tiers = JSON.parse((await inject({ method: 'GET', url: '/api/v1/loyalty/tiers', headers: auth })).body).data.items;
    const base = tiers.find((tier: any) => tier.thresholdPoints === 0);
    expect(base).toBeDefined();
    const res = await inject({ method: 'DELETE', url: `/api/v1/loyalty/tiers/${base.name}`, headers: auth });
    expect(res.statusCode).toBe(400);
  });

  it('匿名讀不到營運設定', async () => {
    expect((await inject({ method: 'GET', url: '/api/v1/loyalty/settings' })).statusCode).toBe(401);
  });

  // 這裡驗的是端點有被守住；「寫入確實搬到 loyalty:write」由 loyalty-operations 那支
  // 以一個持有 promotion:write 但沒有 loyalty:write 的身分驗，mcp token 兩種情況都會 403。
  it('沒有 loyalty:write 的 token 改不動設定與等級', async () => {
    expect((await inject({ method: 'PATCH', url: '/api/v1/loyalty/settings', headers: mcp, payload: { accrualBasisPoints: 1 } })).statusCode).toBe(403);
    expect((await inject({ method: 'PUT', url: '/api/v1/loyalty/tiers', headers: mcp, payload: { name: 'nope', thresholdPoints: 1, multiplierBasisPoints: 10000 } })).statusCode).toBe(403);
  });
});

describe('工單 73／74：通知紀錄與生日更正的 HTTP 面', () => {
  const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const mcp = { authorization: `Bearer ${MCP_TOKEN}` };

  it('通知紀錄讀得到，limit 不是數字時回 400 而不是 500', async () => {
    const res = await inject({ method: 'GET', url: '/api/v1/notification-deliveries?limit=5', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toMatchObject({ items: expect.any(Array), total: expect.any(Number) });
    expect((await inject({ method: 'GET', url: '/api/v1/notification-deliveries?limit=abc', headers: auth })).statusCode).toBe(400);
  });

  it('通知紀錄擋匿名與沒有 notification:read 的 token', async () => {
    expect((await inject({ method: 'GET', url: '/api/v1/notification-deliveries' })).statusCode).toBe(401);
    expect((await inject({ method: 'GET', url: '/api/v1/notification-deliveries', headers: mcp })).statusCode).toBe(403);
  });

  it('生日更正沒帶原因回 400，帶了不存在的會員回 404', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const noReason = await inject({ method: 'POST', url: `/api/v1/customers/${missing}/birthday`, headers: auth, payload: { birthday: '1990-01-01' } });
    expect(noReason.statusCode).toBe(400);
    const notFound = await inject({ method: 'POST', url: `/api/v1/customers/${missing}/birthday`, headers: auth, payload: { birthday: '1990-01-01', reason: '客服更正' } });
    expect(notFound.statusCode).toBe(404);
  });

  it('生日不是真的日曆日就回 400，形狀對不代表日期存在', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const res = await inject({ method: 'POST', url: `/api/v1/customers/${missing}/birthday`, headers: auth, payload: { birthday: '1990-02-31', reason: '客服更正' } });
    expect(res.statusCode).toBe(400);
  });

  it('生日更正擋匿名與沒有 customers:manage 的 token', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await inject({ method: 'POST', url: `/api/v1/customers/${missing}/birthday`, payload: { birthday: '1990-01-01', reason: 'x' } })).statusCode).toBe(401);
    expect((await inject({ method: 'POST', url: `/api/v1/customers/${missing}/birthday`, headers: mcp, payload: { birthday: '1990-01-01', reason: 'x' } })).statusCode).toBe(403);
  });
});
