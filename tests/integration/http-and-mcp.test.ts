import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createServer } from '@storeweave/api';
import { defaultTheme } from '@storeweave/theme-default';
import { createHarness, createProduct, stockUp, storefrontCheckoutForm, type TestHarness } from './helpers';

const ADMIN_TOKEN = 'test-admin-token-abcdefghijklmnop';
const MCP_TOKEN = 'test-mcp-token-abcdefghijklmnop';

let h: TestHarness;
let app: NestFastifyApplication;

beforeAll(async () => {
  h = await createHarness();
  // 直接把 token 設定注入 runtime，模擬 commerce.yaml 的 auth.tokens
  (h.runtime.config.auth.tokens as unknown[]).push(
    { name: 'admin', role: 'admin', secretRef: 'ADMIN_TOKEN' },
    { name: 'mcp', role: 'mcp', secretRef: 'MCP_TOKEN' },
  );
  (h.runtime as { secrets: any }).secrets = {
    get: (n: string) => ({ ADMIN_TOKEN, MCP_TOKEN, DEMO_ERP_API_KEY: 'test-key' } as Record<string, string>)[n],
    has: (n: string) => Boolean(({ ADMIN_TOKEN, MCP_TOKEN, DEMO_ERP_API_KEY: 'k' } as Record<string, string>)[n]),
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
        method: 'GET', url: '/api/v1/extensions/demo-erp/queries/ext.demo-erp.listDeliveries?limits=10', headers: auth(),
      });

      expect(res.statusCode).toBe(200);
      expect(warn.mock.calls.some(([fields]) => JSON.stringify(fields).includes('limits'))).toBe(true);
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

  it('tools/list 只公開設定啟用的工具', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = res.json().result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['adjust_inventory', 'get_order', 'get_sales_summary', 'search_products']);
    expect(res.json().result.tools[0].inputSchema).toHaveProperty('type');
  });

  it('未知方法回 JSON-RPC error', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'nope' });
    expect(res.json().error.code).toBe(-32601);
  });

  it('MCP 執行的寫入會經過 Command Bus 的權限與 Idempotency 檢查', async () => {
    const product = await createProduct(h.runtime, { sku: 'MCP-1' });
    const call = (args: Record<string, unknown>) =>
      rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'adjust_inventory', arguments: args } });

    const missingKey = await call({ productId: product.id, delta: 5, reason: 'restock' });
    expect(missingKey.json().result.isError).toBe(true);

    const ok = await call({ productId: product.id, delta: 5, reason: 'restock', idempotencyKey: 'mcp-key-1' });
    expect(ok.json().result.structuredContent.onHand).toBe(5);

    const replay = await call({ productId: product.id, delta: 5, reason: 'restock', idempotencyKey: 'mcp-key-1' });
    expect(replay.json().result.structuredContent.onHand).toBe(5);
  });

  it('MCP token 的角色限制了它能做什麼', async () => {
    const res = await rpc({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'get_order', arguments: { orderNumber: 'NOPE-1' } },
    });
    expect(res.json().result.isError).toBe(true);
    expect(res.json().result.content[0].text).toContain('NOT_FOUND');
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
