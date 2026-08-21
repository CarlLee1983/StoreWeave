import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { commerceConfigSchema, type CommerceConfig, type SecretProvider } from '@storeweave/config';
import { createRuntime, Worker, type Runtime } from '@storeweave/kernel';
import { ProviderRegistry } from '@storeweave/extension-sdk';
import { noopLogger, type Actor } from '@storeweave/contracts';
import { AVAILABLE_EXTENSIONS, coreModules } from '@storeweave/bundle';

export const ADMIN_ACTOR: Actor = { id: 'test:admin', type: 'user', displayName: 'admin', permissions: ['*'] };

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
    'demo-erp': { endpoint: 'mock://demo-erp' },
    mcp: {},
  };
  return commerceConfigSchema.parse({
    version: 1,
    store: { id: options.storeId ?? 'test-store', name: 'Test Store', currency: 'TWD' },
    database: { url, poolSize: 5 },
    worker: { pollIntervalMs: 50, concurrency: 4 },
    auth: { tokens: [] },
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
    modules: coreModules({ providers, defaultCurrency: config.store.currency, orderNumberPrefix: 'TST' }),
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

export async function placeOrder(runtime: Runtime, productId: string, quantity = 1) {
  return runtime.commands.execute<{
    id: string; number: string; status: string; subtotalCents: number; totalCents: number;
    discountCents: number; shippingCents: number; taxCents: number;
    lines: { discountCents: number }[];
  }>(
    'commerce.order.placeOrder',
    { customerEmail: 'buyer@example.com', lines: [{ productId, quantity }] },
    { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() },
  );
}

export async function payOrder(runtime: Runtime, orderId: string) {
  return runtime.commands.execute<{ id: string; status: string }>(
    'commerce.order.payOrder', { orderId }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() },
  );
}
