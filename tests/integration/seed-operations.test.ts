import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { commerceConfigSchema } from '@storeweave/config';
import { PUSH_ORDER_JOB } from '../../packages/extensions/demo-erp/src/config';
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from './helpers';

const root = resolve(process.cwd());
const signingKey = Buffer.alloc(32, 7).toString('base64url');

function runSeed(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('pnpm', args, {
    cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
}

function seedOpsBeforeCurrentRelease(env: NodeJS.ProcessEnv): number | null {
  return spawnSync('pnpm', ['seed:ops'], { cwd: root, env, stdio: 'ignore', timeout: 120_000 }).status;
}

describe('operations seed CLI', () => {
  it('requires a current Release, then completes twice without claiming another ERP job', async () => {
    const databaseUrl = await createTestDatabase();
    const directory = mkdtempSync(join(tmpdir(), 'storeweave-seed-ops-'));
    const configPath = join(directory, 'commerce.yaml');
    const config = commerceConfigSchema.parse({
      version: 1,
      store: { id: 'seed-ops-test', name: 'Seed Operations Test' },
      database: { url: databaseUrl },
      paths: { dataDir: join(directory, 'data'), backupDir: join(directory, 'backups') },
      security: { signingKeys: [{ id: 'test', secretRef: 'COMMERCE_SIGNING_KEY_K1' }] },
      extensions: [
        { id: 'mock-payment', enabled: true, config: { autoApprove: true, declineAboveCents: 0 } },
        { id: 'demo-erp', enabled: true, config: { endpoint: 'mock://demo-erp' } },
      ],
    });
    writeFileSync(configPath, JSON.stringify(config));
    const env = { ...process.env };
    delete env.STOREWEAVE_CONFIG;
    Object.assign(env, {
      COMMERCE_CONFIG: configPath,
      COMMERCE_SIGNING_KEY_K1: signingKey,
      DEMO_ERP_API_KEY: 'synthetic-seed-test-key',
    });
    const database = new Client({ connectionString: databaseUrl });

    try {
      await database.connect();
      expect(seedOpsBeforeCurrentRelease(env)).not.toBe(0);
      expect((await database.query<{ orders: string | null }>("SELECT to_regclass('public.order_orders') AS orders")).rows[0]?.orders).toBeNull();

      runSeed(['seed', '--', '--demo'], env);
      const unrelatedJobId = randomUUID();
      await database.query(`
        INSERT INTO platform_jobs (id, occurrence_id, type, payload, payload_version, status, attempts, max_attempts, run_at)
        VALUES ($1, $1, $2, $3::jsonb, 1, 'pending', 0, 5, now() - interval '1 minute')
      `, [unrelatedJobId, PUSH_ORDER_JOB, JSON.stringify({ orderId: randomUUID() })]);

      const firstRun = runSeed(['seed:ops'], env);
      expect(firstRun).toContain('🎉 營運示範資料完成');
      expect(firstRun).toContain('✓ 死信佇列：1 筆');
      const firstOrderCount = Number((await database.query<{ count: string }>('SELECT count(*) AS count FROM order_orders')).rows[0]?.count);
      const firstFlows = (await database.query<{ payments: number; shipments: number; refunds: number; rmas: number; erpDeliveries: number }>(`
        SELECT
          (SELECT count(*)::int FROM order_payments) AS payments,
          (SELECT count(*)::int FROM shipping_shipments) AS shipments,
          (SELECT count(*)::int FROM refund_refunds) AS refunds,
          (SELECT count(*)::int FROM rma_cases) AS rmas,
          (SELECT count(*)::int FROM platform_extension_state WHERE extension_id = 'demo-erp' AND key LIKE 'delivery:%') AS "erpDeliveries"
      `)).rows[0]!;
      for (const count of Object.values(firstFlows)) expect(count).toBeGreaterThan(0);
      expect((await database.query('SELECT status FROM platform_jobs WHERE id = $1', [unrelatedJobId])).rows[0]?.status).toBe('pending');
      expect((await database.query("SELECT count(*)::int AS count FROM platform_jobs WHERE type = $1 AND status = 'dead'", [PUSH_ORDER_JOB])).rows[0]?.count).toBe(1);

      const secondRun = runSeed(['seed:ops'], env);
      expect(secondRun).toContain('🎉 營運示範資料完成');
      const secondOrderCount = Number((await database.query<{ count: string }>('SELECT count(*) AS count FROM order_orders')).rows[0]?.count);
      expect(secondOrderCount).toBeGreaterThan(firstOrderCount);
      const secondFlows = (await database.query<{ payments: number; shipments: number; refunds: number; rmas: number; erpDeliveries: number }>(`
        SELECT
          (SELECT count(*)::int FROM order_payments) AS payments,
          (SELECT count(*)::int FROM shipping_shipments) AS shipments,
          (SELECT count(*)::int FROM refund_refunds) AS refunds,
          (SELECT count(*)::int FROM rma_cases) AS rmas,
          (SELECT count(*)::int FROM platform_extension_state WHERE extension_id = 'demo-erp' AND key LIKE 'delivery:%') AS "erpDeliveries"
      `)).rows[0]!;
      for (const [name, count] of Object.entries(secondFlows)) {
        expect(count, `${name} grows on the second seed run`).toBeGreaterThan(firstFlows[name as keyof typeof firstFlows]);
      }
      expect((await database.query('SELECT status FROM platform_jobs WHERE id = $1', [unrelatedJobId])).rows[0]?.status).toBe('pending');
      expect((await database.query("SELECT count(*)::int AS count FROM platform_jobs WHERE type = $1 AND status = 'dead'", [PUSH_ORDER_JOB])).rows[0]?.count).toBe(2);
    } finally {
      await database.end();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
