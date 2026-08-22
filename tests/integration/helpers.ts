import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { commerceConfigSchema, type CommerceConfig, type SecretProvider } from '@storeweave/config';
import { createRuntime, Worker, type Runtime } from '@storeweave/kernel';
import { ProviderRegistry } from '@storeweave/extension-sdk';
import { noopLogger, type Actor } from '@storeweave/contracts';
import { permissionsForRole } from '@storeweave/authorization';
import { AVAILABLE_EXTENSIONS, coreModules } from '@storeweave/bundle';

export const ADMIN_ACTOR: Actor = { id: 'test:admin', type: 'user', displayName: 'admin', permissions: ['*'] };

/** 匿名訪客：註冊要用它，因為註冊發生在身分存在之前。 */
export const STOREFRONT_ACTOR: Actor = {
  id: 'storefront', type: 'service', displayName: 'storefront', permissions: permissionsForRole('storefront'),
};

export function actorWith(permissions: string[]): Actor {
  return { id: 'test:limited', type: 'user', displayName: 'limited', permissions };
}

const baseUrl = () => process.env.TEST_PG_URL ?? '';

/** 每個測試檔案拿到自己的資料庫，彼此完全隔離。 */
export async function createTestDatabase(): Promise<string> {
  const name = `t_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const admin = new Client({ connectionString: baseUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return baseUrl().replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
}

export interface TestRuntimeOptions {
  extensions?: Record<string, unknown>;
  secrets?: Record<string, string>;
  storeId?: string;
}

export interface TestHarness {
  runtime: Runtime;
  worker: Worker;
  close(): Promise<void>;
}

export function testSecretProvider(values: Record<string, string>): SecretProvider {
  return {
    get: (name) => values[name],
    has: (name) => Boolean(values[name]),
    listNames: () => Object.keys(values),
  };
}

export function testConfig(url: string, options: TestRuntimeOptions = {}): CommerceConfig {
  const extensionEntries = options.extensions ?? {
    'mock-payment': { autoApprove: true },
    // 測試要斷言信件內容，因此明確打開留存；正式設定預設是關的。
    'mock-notification': { deliver: true, retainSensitiveVariables: true },
    'demo-erp': { endpoint: 'mock://demo-erp' },
    mcp: {},
  };
  return commerceConfigSchema.parse({
    version: 1,
    store: { id: options.storeId ?? 'test-store', name: 'Test Store', currency: 'TWD' },
    database: { url, poolSize: 5 },
    worker: { pollIntervalMs: 50, concurrency: 4 },
    auth: { tokens: [] },
    // 明寫本機位址：cookie 的名字看它。localhost 發不出 Secure，因此測試裡的 cookie 都是
    // 裸名（`commerce_session` 而不是 `__Host-commerce_session`），其他整合測試才寫得出
    // `cookies: { [SESSION_COOKIE]: ... }`。改動這一行會讓那些檔案一起失敗——那是預期的，
    // 前綴的行為由 `host-cookies.test.ts` 自己換掉 publicUrl 來蓋（ADR 0023）。
    http: { publicUrl: 'http://localhost:3000' },
    extensions: Object.entries(extensionEntries).map(([id, config]) => ({ id, enabled: true, config })),
    logging: { level: 'error' },
  });
}

export async function createHarness(options: TestRuntimeOptions = {}): Promise<TestHarness> {
  const url = await createTestDatabase();
  const config = testConfig(url, options);
  const secrets = testSecretProvider({ DEMO_ERP_API_KEY: 'test-key', ...options.secrets });
  const providers = new ProviderRegistry(noopLogger);

  const runtime = await createRuntime({
    config,
    secrets,
    logger: noopLogger,
    providers,
    modules: coreModules({ providers, defaultCurrency: config.store.currency, orderNumberPrefix: 'TST', timezone: config.store.timezone, locale: config.store.locale }),
    availableExtensions: AVAILABLE_EXTENSIONS,
  });
  await runtime.migrate();

  const worker = new Worker(runtime, { pollIntervalMs: 50, workerId: 'test-worker' });
  return {
    runtime,
    worker,
    async close() {
      await worker.stop();
      await runtime.close();
    },
  };
}

export async function createProduct(runtime: Runtime, overrides: Record<string, unknown> = {}) {
  return runtime.commands.execute<{ id: string; sku: string; priceCents: number }>(
    'commerce.catalog.createProduct',
    { sku: `SKU-${randomUUID().slice(0, 8)}`, name: 'Test Product', priceCents: 1000, currency: 'TWD', status: 'active', ...overrides },
    { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() },
  );
}

export async function stockUp(runtime: Runtime, productId: string, delta: number) {
  return runtime.commands.execute('commerce.inventory.adjustStock',
    { productId, delta, reason: 'restock' },
    { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
}

/**
 * 註冊一個顧客並回傳它的 Actor。下單者由身分決定（工單 21），
 * 因此測試裡的每一張訂單都要有一個真的顧客。
 */
export async function createCustomer(
  runtime: Runtime,
  overrides: { email?: string; password?: string; displayName?: string } = {},
): Promise<Actor & { email: string; customerId: string }> {
  const email = overrides.email ?? `buyer-${randomUUID().slice(0, 8)}@example.com`;
  const registered = await runtime.commands.execute<{ customer: { id: string }; accountId: string }>(
    'commerce.customer.registerCustomer',
    { email, password: overrides.password ?? 'test-password', displayName: overrides.displayName },
    { actor: STOREFRONT_ACTOR, idempotencyKey: randomUUID() },
  );
  return {
    id: `user:${registered.accountId}`,
    type: 'customer',
    displayName: overrides.displayName ?? email,
    permissions: permissionsForRole('customer'),
    email,
    customerId: registered.customer.id,
  };
}

/** 同一個測試檔共用一位顧客就夠了，除非測試本身在驗證「不同顧客」。 */
const sharedCustomers = new WeakMap<Runtime, Promise<Actor & { email: string; customerId: string }>>();

export function defaultCustomer(runtime: Runtime) {
  let existing = sharedCustomers.get(runtime);
  if (!existing) {
    existing = createCustomer(runtime);
    sharedCustomers.set(runtime, existing);
  }
  return existing;
}

export async function placeOrder(runtime: Runtime, productId: string, quantity = 1, actor?: Actor) {
  const buyer = actor ?? (await defaultCustomer(runtime));
  return runtime.commands.execute<{
    id: string; number: string; status: string; subtotalCents: number; totalCents: number;
    discountCents: number; shippingCents: number; taxCents: number; customerEmail: string; customerId: string | null;
    lines: { discountCents: number }[];
  }>(
    'commerce.order.placeOrder',
    { lines: [{ productId, quantity }] },
    { actor: buyer, idempotencyKey: randomUUID() },
  );
}

export async function payOrder(runtime: Runtime, orderId: string) {
  return runtime.commands.execute<{ id: string; status: string }>(
    'commerce.order.payOrder', { orderId }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() },
  );
}

/**
 * 跑到工作真的被處理為止。
 *
 * `run_at` 由 Node 產生而認領條件的 `now()` 來自 Postgres，兩者之間的毫秒級偏移
 * 會讓「排入後立刻跑一輪」撲空。這不是行為問題，是時鐘問題——輪詢到處理完成
 * 才是穩定的斷言方式。
 */
export async function runJobsUntilProcessed(
  worker: TestHarness['worker'],
  expected = 1,
  attempts = 60,
): Promise<{ processed: number; failed: number }> {
  const total = { processed: 0, failed: 0 };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const round = await worker.runJobs();
    total.processed += round.processed;
    total.failed += round.failed;
    if (total.processed >= expected || total.failed > 0) return total;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return total;
}

/**
 * 反覆 drain 直到連續兩輪真的沒事可做。
 *
 * 單一 `drain()` 在「這一輪剛排進來的工作還不到 run_at」時就會停——
 * `run_at` 由 Node 產生而認領條件的 `now()` 來自 Postgres，兩者差幾毫秒就足夠。
 * 工作鏈（付款 → outbox → 投遞）每多一段，撞上這個縫的機率就高一次。
 */
export async function settleWorker(worker: TestHarness['worker'], rounds = 20): Promise<void> {
  let quiet = 0;
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    const result = await worker.drain();
    const idle = result.jobsProcessed === 0 && result.jobsFailed === 0 && result.relayed === 0;
    if (idle && ++quiet >= 2) return;
    if (!idle) quiet = 0;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
