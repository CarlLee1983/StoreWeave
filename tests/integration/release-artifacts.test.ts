import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { catalogDigest } from '@storeweave/db';
import { createTestDatabase } from './helpers';

const exec = promisify(execFile);
let directory: string;
beforeAll(() => { directory = mkdtempSync(join(tmpdir(), 'storeweave-artifacts-')); });
afterAll(() => { if (directory) rmSync(directory, { recursive: true }); });

async function processSmoke(file: string, env: NodeJS.ProcessEnv, ready: string, check: () => Promise<void>) {
  const child = spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  const deadline = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`Process exited before readiness: ${output}`)));
      child.stderr.on('data', data => { output += data; });
      child.stdout.on('data', data => { output += data; if (output.includes(ready)) resolve(); });
    });
    await check();
    child.kill('SIGTERM');
    expect(await exited, output).toBe(0);
    expect(output).toContain('shutting down');
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
}

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  return address.port;
}

describe('release process artifacts', () => {
  it('migrationless Base upgrades refuse API, worker and operational CLI until explicitly activated', async () => {
    const builds = ['0.2.0', '0.2.1'].map(version => ({ version, output: join(directory, `base-${version}`) }));
    for (const { version, output } of builds) {
      await exec(process.execPath, ['scripts/build.mjs'], {
        env: { ...process.env, STOREWEAVE_RELEASE: 'base', STOREWEAVE_RELEASE_VERSION: version, STOREWEAVE_BUILD_DIR: output }, timeout: 60_000,
      });
    }
    const url = await createTestDatabase();
    const config = join(directory, 'migrationless-base.yaml');
    writeFileSync(config, JSON.stringify({
      version: 1, store: { id: 'migrationless', name: 'Migrationless' }, database: { url, autoMigrate: false },
      worker: { enabled: true }, http: { host: '127.0.0.1', port: await availablePort() }, logging: { level: 'error' }, extensions: [],
    }));
    const env = { ...process.env, STOREWEAVE_CONFIG: config };
    const oldCli = join(builds[0]!.output, 'app/cli.js');
    const nextCli = join(builds[1]!.output, 'app/cli.js');
    await exec(process.execPath, [oldCli, 'migrate'], { env, timeout: 15_000 });
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const before = (await client.query('SELECT * FROM platform_migrations ORDER BY id')).rows;
      const status = await exec(process.execPath, [nextCli, 'migrate', '--status', '--json'], { env, timeout: 15_000 });
      expect(JSON.parse(status.stdout)).toMatchObject({ releaseCurrent: false, pending: [] });
      for (const entry of ['api', 'worker']) {
        await expect(exec(process.execPath, [join(builds[1]!.output, `app/${entry}.js`)], { env, timeout: 10_000 }))
          .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Release transition requires the migrate command') });
      }
      await expect(exec(process.execPath, [nextCli, 'extension:list', '--json'], { env, timeout: 10_000 }))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Release transition requires the migrate command') });
      try {
        await exec(process.execPath, [nextCli, 'doctor', '--json'], { env, timeout: 10_000 });
        throw new Error('Doctor accepted a pending release');
      } catch (error) {
        expect(error).toMatchObject({ code: 1 });
        expect(JSON.parse((error as { stdout: string }).stdout).checks).toContainEqual({
          name: 'release activation', status: 'fail', detail: 'Release transition requires the migrate command while writers are stopped',
        });
      }
      expect((await client.query('SELECT count(*)::int AS count FROM platform_release_history')).rows).toEqual([{ count: 1 }]);
      await exec(process.execPath, [nextCli, 'migrate'], { env, timeout: 15_000 });
      const current = await exec(process.execPath, [nextCli, 'migrate', '--status', '--json'], { env, timeout: 15_000 });
      expect(JSON.parse(current.stdout)).toMatchObject({ releaseCurrent: true, pending: [] });
      expect((await client.query('SELECT * FROM platform_migrations ORDER BY id')).rows).toEqual(before);
      expect((await client.query('SELECT count(*)::int AS count FROM platform_release_history')).rows).toEqual([{ count: 2 }]);
    } finally { await client.end(); }
  });

  for (const releaseId of ['base', 'commerce']) {
    it(`${releaseId}: four bundles, repeatable seed, API/worker lifecycle and listen failure`, async () => {
      const output = join(directory, releaseId);
      await exec(process.execPath, ['scripts/build.mjs'], {
        env: { ...process.env, STOREWEAVE_RELEASE: releaseId, STOREWEAVE_RELEASE_VERSION: '0.1.2-test', STOREWEAVE_BUILD_DIR: output },
        timeout: 60_000,
      });
      const info = JSON.parse(readFileSync(join(output, 'build-info.json'), 'utf8'));
      expect(info.releaseId).toBe(releaseId);
      expect(info.version).toBe('0.1.2-test');
      const manifest = JSON.parse(readFileSync(join(output, 'release-manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({ schemaVersion: 1, releaseId, releaseVersion: '0.1.2-test' });
      expect(info.manifestChecksum).toBe(catalogDigest(manifest));
      expect(manifest.modules).toHaveLength(releaseId === 'base' ? 4 : 18);
      if (releaseId === 'base') {
        expect(manifest.availableExtensions).toEqual([]);
        for (const file of ['release-manifest.js.meta.json', 'scripts/validate-release.js.meta.json']) {
          const graph = JSON.parse(readFileSync(join(output, file), 'utf8'));
          expect(Object.keys(graph.inputs).filter(file => /packages\/(commerce|extensions)\//.test(file))).toEqual([]);
        }
      }
      const version = await exec(process.execPath, [join(output, 'app/cli.js'), '--version']);
      expect(version.stdout.trim()).toBe('0.1.2-test');
      expect(info.entries).toHaveLength(4);
      expect(existsSync(join(output, 'admin/index.html'))).toBe(releaseId === 'commerce');
      expect(existsSync(join(output, 'theme-assets'))).toBe(releaseId === 'commerce');
      for (const entry of ['api', 'worker', 'cli', 'seed']) {
        expect(readFileSync(join(output, 'app', `${entry}.js`), 'utf8')).toContain(info.manifestChecksum);
        const graph = JSON.parse(readFileSync(join(output, 'app', `${entry}.js.meta.json`), 'utf8'));
        if (releaseId === 'base') {
          expect(Object.keys(graph.inputs).filter(file => /packages\/(commerce|extensions)\//.test(file))).toEqual([]);
        }
      }
      const url = await createTestDatabase();
      const config = join(directory, `${releaseId}.yaml`);
      writeFileSync(config, JSON.stringify({
        version: 1, store: { id: 'artifact-test', name: 'Artifact test' },
        database: { url }, worker: { enabled: false }, logging: { level: 'error' }, extensions: [],
      }));
      const env = { ...process.env, STOREWEAVE_CONFIG: config, B02_SMOKE_TOKEN: 'isolated-artifact-smoke-token' };
      const seedFile = join(output, 'app/seed.js');
      const first = await exec(process.execPath, [seedFile], { env, timeout: 15_000 });
      expect(JSON.parse(first.stdout)).toMatchObject({ release: releaseId, demo: false });
      const second = await exec(process.execPath, [seedFile], { env, timeout: 15_000 });
      expect(JSON.parse(second.stdout)).toEqual({ release: releaseId, applied: [], demo: false });
      await exec(process.execPath, [join(output, 'app/cli.js'), 'migrate'], { env, timeout: 15_000 });
      await exec(process.execPath, [join(output, 'app/worker.js')], { env, timeout: 15_000 });
      if (releaseId === 'base') {
        await expect(exec(process.execPath, [seedFile, '--demo'], { env, timeout: 15_000 })).rejects.toMatchObject({ code: 1 });
      }
      const client = new Client({ connectionString: url });
      await client.connect();
      try {
        const users = await client.query('SELECT count(*)::int AS count FROM platform_users');
        expect(users.rows).toEqual([{ count: 0 }]);
        if (releaseId === 'commerce') {
          expect((await client.query('SELECT count(*)::int AS count FROM catalog_products')).rows).toEqual([{ count: 0 }]);
          // Corrupt modern history must refuse activation; it cannot be relabeled as a legacy baseline.
          await client.query('UPDATE platform_migrations SET checksum = NULL, migration_order = NULL');
          const cli = join(output, 'app/cli.js');
          await expect(exec(process.execPath, [cli, 'migrate'], { env, timeout: 15_000 })).rejects.toMatchObject({ code: 1 });
          await expect(exec(process.execPath, [cli, 'migrate', 'baseline',
            '--catalog', 'legacy-commerce-0.1.0-pre-b02', '--evidence', 'corrupted modern fixture'], { env, timeout: 15_000 }))
            .rejects.toMatchObject({ code: 1 });
          // Reset this disposable ledger to the pinned old three-column, pre-B04 history.
          // The exact historical DDL fixture is covered by release-transition.
          await client.query(`DELETE FROM platform_migrations WHERE id IN (
              'platform/0003_job_occurrence_fencing',
              'platform/0004_job_payload_quarantine',
              'platform/0005_outbox_subscriber_snapshot_quarantine',
              'platform/0006_job_retention_dedupe_horizon',
              'platform/0007_ops_listing_indexes',
              'platform-cache/0001_init'
            );
            DROP TABLE platform_release_history;
            ALTER TABLE platform_migrations DROP COLUMN checksum, DROP COLUMN migration_order,
              DROP COLUMN legacy_baseline_id, DROP COLUMN migration_owner, DROP COLUMN migration_id,
              DROP COLUMN module_id, DROP COLUMN module_version, DROP COLUMN release_id, DROP COLUMN release_version;
            DROP TABLE platform_migration_baselines`);
          const adopted = await exec(process.execPath, [cli, 'migrate', 'baseline',
            '--catalog', 'legacy-commerce-0.1.0-pre-b02', '--evidence', 'isolated CLI legacy fixture'], { env, timeout: 15_000 });
          expect(JSON.parse(adopted.stdout).historicalSqlVerified).toBe(false);
          expect(JSON.parse(adopted.stdout).historicalRuntimeVerified).toBe(false);
          expect(JSON.parse(adopted.stdout).adopted).toHaveLength(49);
          await exec(process.execPath, [cli, 'migrate'], { env, timeout: 15_000 });
          const demoState = async () => (await client.query(`SELECT
            (SELECT count(*)::int FROM catalog_products) AS products,
            (SELECT count(*)::int FROM platform_users) AS users,
            (SELECT jsonb_agg(to_jsonb(s) ORDER BY product_id) FROM inventory_stock s) AS stock,
            (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM loyalty_reward_entries r) AS rewards,
            (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM shipping_methods s) AS shipping,
            (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM promotion_promotions p) AS promotions,
            (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM coupon_coupons c) AS coupons,
            (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM loyalty_tiers t) AS tiers,
            (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM loyalty_tier_entries t) AS points,
            (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM content_articles a) AS articles`)).rows[0];
          await client.query("ALTER TABLE shipping_methods ADD CONSTRAINT fixture_reject_seed CHECK (code <> 'black-cat-delivery')");
          await expect(exec(process.execPath, [seedFile, '--demo'], { env, timeout: 30_000 }))
            .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Seed failed:') });
          await client.query('ALTER TABLE shipping_methods DROP CONSTRAINT fixture_reject_seed');
          await exec(process.execPath, [seedFile, '--demo'], { env, timeout: 30_000 });
          const demo = await demoState();
          expect(demo.products).toBeGreaterThan(0);
          expect(demo.users).toBe(3);
          // The demo intentionally includes one sold-out product without an initial stock movement.
          expect(demo.stock).toHaveLength(demo.products - 1);
          expect(demo.rewards).toHaveLength(1);
          expect(demo.shipping).toHaveLength(4);
          expect(demo.promotions).toHaveLength(4);
          expect(demo.coupons).toHaveLength(3);
          expect(demo.tiers).toHaveLength(4);
          expect(demo.points).toHaveLength(1);
          expect(demo.articles).toHaveLength(10);
          expect(demo.articles.every((article: { status: string }) => article.status === 'published')).toBe(true);
          await exec(process.execPath, [seedFile, '--demo'], { env, timeout: 30_000 });
          expect(await demoState()).toEqual(demo);
        }
      } finally { await client.end(); }

      const port = await availablePort();
      writeFileSync(config, JSON.stringify({
        version: 1, store: { id: 'artifact-test', name: 'Artifact test' },
        database: { url }, extensions: [], logging: { level: 'info' },
        http: { host: '127.0.0.1', port }, worker: { enabled: true, pollIntervalMs: 50 },
        auth: { tokens: [{ name: 'smoke', role: 'admin', secretRef: 'B02_SMOKE_TOKEN' }] },
        shutdown: { timeoutMs: 2_000 },
      }));
      const api = join(output, 'app/api.js');
      await processSmoke(api, env, 'api listening', async () => {
        const response = await fetch(`http://127.0.0.1:${port}/health/live`);
        expect(response.status).toBe(200);
        // A second real API reaches listen, fails, and cleans its initialized resources.
        await expect(exec(process.execPath, [api], { env, timeout: 10_000 }))
          .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('EADDRINUSE') });
        await processSmoke(join(output, 'app/worker.js'), env, 'worker running', async () => {
          expect((await fetch(`http://127.0.0.1:${port}/health/live`)).status).toBe(200);
          if (releaseId === 'base') {
            await exec('bash', ['scripts/smoke-base.sh'], {
              env: { ...env, BASE_URL: `http://127.0.0.1:${port}`, ADMIN_TOKEN: env.B02_SMOKE_TOKEN }, timeout: 15_000,
            });
          }
        });
      });
    });
  }
});
