import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { bookingReleaseDefinition, validateBookingReleaseDefinition } from '../../packages/releases/booking/src/definition';

const exec = promisify(execFile);
const signingSecret = Buffer.alloc(32, 19).toString('base64url');
let container: StartedPostgreSqlContainer;
let directory: string;
let output: string;

type Manifest = { releaseId: string; modules: { id: string; migrationOwner: string | null; migrations: { id: string }[] }[] };

function databaseUrl(name: string): string {
  const url = new URL(container.getConnectionUri());
  url.pathname = `/${name}`;
  return url.toString();
}

async function createDatabase(name: string): Promise<string> {
  const admin = new Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${name}`); }
  finally { await admin.end(); }
  return databaseUrl(name);
}

function writeConfig(name: string, url: string, port = 0): string {
  const path = join(directory, `${name}.yaml`);
  writeFileSync(path, JSON.stringify({
    version: 1, store: { id: name, name: 'Booking Clean Start' },
    database: { url, autoMigrate: false },
    booking: { reservationPiiRetentionDays: 365, operatorAlertEmail: 'operator@example.test' },
    extensions: [{ id: 'mock-payment' }],
    ...(port ? { http: { host: '127.0.0.1', port } } : {}),
    logging: { level: 'info' },
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
  }));
  return path;
}

function environment(configPath: string): NodeJS.ProcessEnv {
  return { ...process.env, STOREWEAVE_CONFIG: configPath, SW_SIGNING_KEY_TEST: signingSecret };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  return address.port;
}

async function startApi(env: NodeJS.ProcessEnv, port: number): Promise<void> {
  const child = spawn(process.execPath, [join(output, 'app/api.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  const deadline = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`Booking API exited before listen: ${logs}`)));
      child.stdout.on('data', data => { logs += data; if (logs.includes('api listening')) resolve(); });
      child.stderr.on('data', data => { logs += data; });
    });
    expect((await fetch(`http://127.0.0.1:${port}/health/live`)).status).toBe(200);
    child.kill('SIGTERM');
    expect(await exited, logs).toBe(0);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
}

async function catalog(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const tables = (await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    )).rows.map(row => row.tablename);
    const migrations = (await client.query<{ id: string; migration_owner: string; release_id: string }>(
      'SELECT id, migration_owner, release_id FROM platform_migrations ORDER BY id',
    )).rows;
    return { tables, migrations };
  } finally { await client.end(); }
}

function assertBookingOnly(tables: string[], migrationIds: string[]): void {
  const forbiddenTables = tables.filter(name => !/^(booking_|content_|platform_)/.test(name));
  const forbiddenMigrations = migrationIds.filter(id => !/^(booking-|content\/|identity\/|platform[/-])/.test(id));
  expect(forbiddenTables, `Commerce tables leaked into Booking: ${forbiddenTables.join(', ')}`).toEqual([]);
  expect(forbiddenMigrations, `Commerce migrations leaked into Booking: ${forbiddenMigrations.join(', ')}`).toEqual([]);
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'storeweave-booking-clean-'));
  output = join(directory, 'build');
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('booking_clean_start').withUsername('booking').withPassword('booking').start();
  await exec(process.execPath, ['scripts/build.mjs'], {
    env: { ...process.env, STOREWEAVE_RELEASE: 'booking', STOREWEAVE_BUILD_DIR: output }, timeout: 90_000,
  });
}, 180_000);

afterAll(async () => {
  await container?.stop();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('Booking clean start', () => {
  it('migrates an empty Booking database and starts the selected API without Commerce', async () => {
    const url = databaseUrl('booking_clean_start');
    const port = await availablePort();
    const config = writeConfig('booking', url, port);
    const env = environment(config);
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      expect((await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows).toEqual([]);
    } finally { await client.end(); }

    await exec(process.execPath, [join(output, 'app/cli.js'), 'migrate'], { env, timeout: 30_000 });
    const manifest = JSON.parse(readFileSync(join(output, 'release-manifest.json'), 'utf8')) as Manifest;
    expect(manifest.releaseId).toBe('booking');
    const expected = manifest.modules.flatMap(module => module.migrations.map(migration => `${module.migrationOwner}/${migration.id}`)).sort();
    const { tables, migrations } = await catalog(url);
    expect(migrations.map(row => row.id)).toEqual(expected);
    expect(migrations.every(row => row.release_id === 'booking')).toBe(true);
    expect(migrations.every(row => row.migration_owner === row.id.split('/')[0])).toBe(true);
    expect(tables).toEqual(expect.arrayContaining([
      'booking_property_properties', 'booking_availability_room_nights', 'booking_reservation_reservations',
    ]));
    assertBookingOnly(tables, migrations.map(row => row.id));

    for (const entry of ['api', 'worker', 'cli']) {
      const graph = JSON.parse(readFileSync(join(output, `app/${entry}.js.meta.json`), 'utf8')) as { inputs: Record<string, unknown> };
      const imports = Object.keys(graph.inputs).filter(path =>
        /(^|\/)packages\/(commerce|releases\/commerce|extensions\/(ecpay|demo-erp))\//.test(path)
        || /(^|\/)apps\/api\/src\/releases\/commerce\//.test(path));
      expect(imports, `${entry} imports Commerce implementation: ${imports.join(', ')}`).toEqual([]);
    }
    await startApi(env, port);
  });

  it('rejects missing and duplicate selected manifest entries with named errors', () => {
    const selected = bookingReleaseDefinition.manifest.selected;
    expect(() => validateBookingReleaseDefinition({ manifest: {
      ...bookingReleaseDefinition.manifest, selected: { ...selected, modules: selected.modules.slice(1) },
    } })).toThrow('modules must be exactly');
    expect(() => validateBookingReleaseDefinition({ manifest: {
      ...bookingReleaseDefinition.manifest, selected: { ...selected, modules: [...selected.modules, selected.modules[0]] },
    } })).toThrow('duplicate selected key');
  });

  it('rejects a missing Booking config field and a nonexistent database', async () => {
    const url = await createDatabase('booking_invalid_config');
    const config = writeConfig('invalid-booking', url);
    const value = JSON.parse(readFileSync(config, 'utf8')) as Record<string, unknown>;
    delete value.booking;
    writeFileSync(config, JSON.stringify(value));
    await expect(exec(process.execPath, [join(output, 'app/cli.js'), 'migrate'], {
      env: environment(config), timeout: 15_000,
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('booking') });

    const wrongDatabase = writeConfig('wrong-database', databaseUrl('booking_database_does_not_exist'));
    await expect(exec(process.execPath, [join(output, 'app/cli.js'), 'migrate'], {
      env: environment(wrongDatabase), timeout: 15_000,
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('booking_database_does_not_exist') });
  });

  it('rejects a missing or malformed operator alert mailbox before the Booking API starts', async () => {
    const url = await createDatabase('booking_invalid_alert_recipient');
    for (const [name, mailbox] of [['missing', undefined], ['malformed', 'invalid-address']] as const) {
      const config = writeConfig(`invalid-alert-${name}`, url);
      const value = JSON.parse(readFileSync(config, 'utf8')) as { booking: Record<string, unknown> };
      if (mailbox === undefined) delete value.booking.operatorAlertEmail;
      else value.booking.operatorAlertEmail = mailbox;
      writeFileSync(config, JSON.stringify(value));
      await expect(exec(process.execPath, [join(output, 'app/api.js')], {
        env: environment(config), timeout: 15_000,
      })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('operatorAlertEmail') });
    }
  }, 60_000);

  it('rejects missing Booking migration history after an activated clean start', async () => {
    const url = await createDatabase('booking_missing_migration');
    const config = writeConfig('missing-migration', url);
    const env = environment(config);
    const cli = join(output, 'app/cli.js');
    await exec(process.execPath, [cli, 'migrate'], { env, timeout: 30_000 });
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const selected = (await client.query<{ id: string }>(
        "SELECT id FROM platform_migrations WHERE id LIKE 'booking-%' ORDER BY id LIMIT 1",
      )).rows[0]?.id;
      expect(selected).toBeDefined();
      await client.query('DELETE FROM platform_migrations WHERE id = $1', [selected]);
      await expect(exec(process.execPath, [cli, 'migrate'], { env, timeout: 15_000 }))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(`Stored migration history is missing: ${selected}`) });
    } finally { await client.end(); }
  });

  it('rejects a Commerce-shaped database and reports its foreign migration', async () => {
    const url = await createDatabase('commerce_wrong_database');
    const config = writeConfig('wrong-existing-database', url);
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(`CREATE TABLE platform_migrations (
        id text PRIMARY KEY, phase text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      await client.query("INSERT INTO platform_migrations (id, phase) VALUES ('commerce-order/0001', 'expand')");
      await client.query('CREATE TABLE commerce_order (id integer PRIMARY KEY)');
      const tables = (await client.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      )).rows.map(row => row.tablename);
      expect(() => assertBookingOnly(tables, ['commerce-order/0001'])).toThrow('Commerce tables leaked');
      await expect(exec(process.execPath, [join(output, 'app/cli.js'), 'migrate'], {
        env: environment(config), timeout: 15_000,
      }))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('commerce-order/0001') });
    } finally { await client.end(); }
  });
});
