import { once } from 'node:events';
import { createServer } from 'node:net';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { expect, it } from 'vitest';
import { catalogDigest, legacyBaselineSelection, runMigrations } from '@storeweave/db';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { release } from '../../packages/platform/bundle/src/releases/commerce';
import legacyCommerce from '../../packages/platform/bundle/src/legacy/commerce-pre-b02.json';
import { readLegacyBridgeJournal } from '../../tools/cli/src/legacy-bridge-journal';
import { writeNativeRelease } from '../unit/fixtures/native-release';

it.each(['paired', 'raw'] as const)('real B02 CLI recovers B01 through %s snapshots and durable journals', async recovery => {
  const container = await new PostgreSqlContainer('postgres:17-alpine').withDatabase('legacy_cli').withUsername('fixture').withPassword('fixture').start();
  const root = mkdtempSync(join(tmpdir(), 'storeweave-legacy-cli-'));
  try {
    const home = join(root, 'home'), source = join(home, 'releases', '0.1.0'), media = join(root, 'commerce-0.2.0'), bin = join(root, 'bin');
    writeNativeRelease(source, 'commerce', '0.1.0');
    for (const file of ['RELEASE', 'release-manifest.json', 'scripts/validate-release.js', 'app/seed.js']) rmSync(join(source, file));
    writeFileSync(join(source, 'build-info.json'), JSON.stringify({ version: '0.1.0', builtOnNode: 'v22.17.1', entries: ['/dist/app/api.js', '/dist/app/worker.js', '/dist/app/cli.js'] }));
    copyFileSync(process.execPath, join(source, 'runtime/bin/node'));
    writeFileSync(join(source, 'app/cli.js'), "process.stdout.write('已套用\\n待套用\\n（無）');");
    // An explicit retained B01 host bundle upgrades this fixture to an actual old-runtime recovery check.
    if (process.env.STOREWEAVE_B01_CLI_FIXTURE) {
      copyFileSync(process.env.STOREWEAVE_B01_CLI_FIXTURE, join(source, 'app/cli.js'));
      copyFileSync(join(dirname(process.env.STOREWEAVE_B01_CLI_FIXTURE), 'api.js'), join(source, 'app/api.js'));
      copyFileSync(process.execPath, join(source, 'runtime/bin/node'));
    }
    symlinkSync(source, join(home, 'current'));
    const socket = createServer();
    await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
    const address = socket.address();
    if (!address || typeof address === 'string') throw new Error('Missing API test port');
    const port = address.port;
    await new Promise<void>(resolve => socket.close(() => resolve()));
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ version: 1, store: { id: 'legacy-cli', name: 'Legacy CLI' }, database: { url: container.getConnectionUri() }, http: { host: '127.0.0.1', port }, extensions: [], logging: { level: 'error' } }));
    const { runtime } = await bootstrapRelease(release, { configPath, loggerName: 'legacy-cli-fixture', logDestination: 'stderr' });
    try {
      // Real pinned B01 SQL with its historical metadata shape; source executables are structural fixtures.
      const legacySource = legacyBaselineSelection(legacyCommerce, runtime.migrations);
      await runMigrations(runtime.database.pool, legacySource.migrations);
      const columns = await runtime.database.pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='platform_migrations'");
      for (const { column_name } of columns.rows) if (!['id', 'phase', 'applied_at'].includes(column_name)) {
        await runtime.database.pool.query(`ALTER TABLE public.platform_migrations DROP COLUMN "${column_name.replaceAll('"', '""')}"`);
      }
      await runtime.database.pool.query('DROP TABLE public.platform_release_history; DROP TABLE public.platform_migration_baselines');
      await runtime.database.pool.query("INSERT INTO catalog_products(id, sku, name, price_cents, currency) VALUES ('00000000-0000-4000-8000-000000000001', 'legacy-rollback', 'Original', 123, 'TWD')");
    } finally { await runtime.close(); }
    const trap = await container.exec(['psql', '-U', 'fixture', '-d', 'legacy_cli', '-c',
      "CREATE SCHEMA trap; CREATE FUNCTION trap.to_jsonb(anyelement) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'shadow function called'; END $$; CREATE FUNCTION trap.pg_export_snapshot() RETURNS text LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'shadow export called'; END $$; ALTER DATABASE legacy_cli SET search_path = trap, pg_catalog, public"]);
    expect(trap.exitCode, trap.output).toBe(0);
    const shadowed = await container.exec(['psql', '-U', 'fixture', '-d', 'legacy_cli', '-c', 'SELECT to_jsonb(1)']);
    expect(shadowed.exitCode).not.toBe(0);
    const build = join(root, 'build');
    execFileSync(process.execPath, ['scripts/build.mjs', '--skip-admin'], { env: { ...process.env, STOREWEAVE_RELEASE: 'commerce', STOREWEAVE_RELEASE_VERSION: '0.2.0', STOREWEAVE_BUILD_DIR: build }, timeout: 60000, stdio: 'pipe' });
    writeNativeRelease(media, 'commerce', '0.2.0');
    for (const file of ['build-info.json', 'release-manifest.json', 'app/cli.js']) copyFileSync(join(build, file), join(media, file));
    copyFileSync(process.execPath, join(media, 'runtime/bin/node'));
    const archive = join(root, 'candidate.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', root, 'commerce-0.2.0']);
    mkdirSync(bin);
    // Host orchestration; actual Linux kernel locking has its own integration suite.
    writeFileSync(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    for (const tool of ['pg_dump', 'pg_restore']) writeFileSync(join(bin, tool), `#!/usr/bin/env node
      const args = process.argv.slice(2), i = args.indexOf('--dbname') + 1;
      if (${JSON.stringify(tool)} === 'pg_dump' && require('node:fs').existsSync(${JSON.stringify(join(root, 'fail-pair'))})) process.exit(24);
      if (i) { const u = new URL(args[i]); u.hostname = 'host.docker.internal'; args[i] = u.toString(); }
      const pass = process.env.PGPASSFILE;
      const credentials = pass ? ['--env', 'PGPASSFILE=' + pass, '--mount', 'type=bind,source=' + require('node:path').dirname(pass) + ',target=' + require('node:path').dirname(pass) + ',readonly'] : [];
      try { require('node:child_process').execFileSync('docker', ['run', '--rm', '--add-host', 'host.docker.internal:host-gateway', ...credentials,
        '--mount', ${JSON.stringify(`type=bind,source=${root},target=${root}`)}, '--entrypoint', ${JSON.stringify(tool)}, 'postgres:17-alpine', ...args], { stdio: 'inherit' }); }
      catch (error) { process.exitCode = error.status || 1; }
    `, { mode: 0o755 });
    const hook = join(root, 'crash.cjs');
    writeFileSync(hook, `const fs = require('node:fs'), rename = fs.renameSync;
      const currentCrash = ${JSON.stringify(join(root, 'current-crash'))};
      fs.renameSync = (...args) => {
        if (String(args[1]).endsWith('/current') && fs.existsSync(currentCrash)) {
          if (fs.readFileSync(currentCrash, 'utf8') === 'after') rename(...args);
          process.kill(process.pid, 'SIGKILL');
        }
        if (String(args[1]).endsWith('/bridge.json') && fs.existsSync(${JSON.stringify(join(root, 'crash'))})) process.kill(process.pid, 'SIGKILL'); if (String(args[1]).endsWith('/journal.json') && fs.existsSync(${JSON.stringify(join(root, 'rollback-crash'))}) && JSON.parse(fs.readFileSync(args[0], 'utf8')).phase === 'cutover-committed') process.kill(process.pid, 'SIGKILL'); return rename(...args); };
      if (process.argv[2] === 'migrate' && process.argv.includes('--status') && fs.existsSync(${JSON.stringify(join(root, 'pending-status'))})) { process.stdout.write('已套用\\n待套用\\nplatform/0001 (expand)'); process.exit(0); }
      if (process.argv[2] === 'migrate' && !process.argv.includes('--status') && fs.existsSync(${JSON.stringify(join(root, 'fail-migrate'))})) process.exit(23);
    `);
    const env = { ...process.env, NODE_OPTIONS: `--require=${hook}`, PATH: `${bin}:${process.env.PATH}`, STOREWEAVE_CONFIG: configPath, COMMERCE_CONFIG: configPath,
      STOREWEAVE_HOME: home, STOREWEAVE_DATA_DIR: join(root, 'data'), STOREWEAVE_LOG_DIR: join(root, 'logs') };
    const invoke = (command: string, ...args: string[]) => promisify(execFile)(process.execPath, [join(media, 'app/cli.js'), command, ...args], { env, timeout: 90000, encoding: 'utf8' });
    const run = (...args: string[]) => invoke('upgrade', ...args);
    const common = ['--external-writers-stopped', '--no-restart'];
    await expect(run('--release', archive, ...common)).rejects.toMatchObject({ code: 1 });
    expect(realpathSync(join(home, 'current'))).toBe(realpathSync(source));
    const catalog = ['--from-legacy-b01', '--catalog', 'legacy-commerce-0.1.0-pre-b02', '--evidence', 'owned CLI fixture'];
    writeFileSync(join(root, 'crash'), '');
    await expectSigkill(run('--release', archive, ...catalog, ...common));
    rmSync(join(root, 'crash'));
    const operations = join(home, '.transitions');
    const safety = readdirSync(operations).map(id => join(operations, id)).find(path => {
      try { return JSON.parse(readFileSync(join(path, 'safety.json'), 'utf8')).kind === 'legacy-b01-safety'; } catch { return false; }
    })!;
    const checksum = catalogDigest(JSON.parse(readFileSync(join(safety, 'safety.json'), 'utf8')));
    const drift = await container.exec(['psql', '-U', 'fixture', '-d', 'legacy_cli', '-c', "COMMENT ON DATABASE legacy_cli IS 'changed after safety'"]);
    expect(drift.exitCode, drift.output).toBe(0);
    await expect(run('--safety', safety, '--checksum', checksum, ...catalog, ...common))
      .rejects.toMatchObject({ stderr: expect.stringContaining('B01 database differs from its original safety snapshot') });
    const unadopted = await container.exec(['psql', '-U', 'fixture', '-d', 'legacy_cli', '-At', '-c',
      "SELECT to_regclass('public.platform_release_history') IS NULL AND to_regclass('public.platform_migration_baselines') IS NULL; SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='platform_migrations'; COMMENT ON DATABASE legacy_cli IS NULL"]);
    expect(unadopted.exitCode, unadopted.output).toBe(0);
    expect(unadopted.stdout.trim()).toBe('t\n3\nCOMMENT');
    if (recovery === 'raw') {
      writeFileSync(join(root, 'fail-pair'), '');
      await expect(run('--safety', safety, '--checksum', checksum, ...catalog, ...common))
        .rejects.toMatchObject({ stderr: expect.stringContaining('pg_dump failed') });
      rmSync(join(root, 'fail-pair'));
      expect(readdirSync(operations).some(id => {
        try { readFileSync(join(operations, id, 'snapshot.json')); return true; } catch { return false; }
      })).toBe(false);
      const before = await container.exec(['psql', '-U', 'fixture', '-d', 'legacy_cli', '-At', '-c',
        "SELECT count(*) FROM public.platform_migration_baselines; UPDATE catalog_products SET name = 'Changed after safety' WHERE sku = 'legacy-rollback'"]);
      expect(before.exitCode, before.output).toBe(0);
      expect(before.stdout.trim().split('\n')[0]).toBe('1');
      const args = ['--safety', safety, '--checksum', checksum, '--yes', ...common];
      await expect(invoke('rollback', ...args)).rejects.toMatchObject({ stderr: expect.stringContaining('requires --to-legacy-b01') });
      writeFileSync(join(root, 'rollback-crash'), '');
      await expectSigkill(invoke('rollback', '--to-legacy-b01', ...args));
      rmSync(join(root, 'rollback-crash'));
      const restoreFile = readdirSync(operations).map(id => join(operations, id, 'journal.json')).find(path => {
        try { return JSON.parse(readFileSync(path, 'utf8')).kind === 'legacy-b01-safety-restore'; } catch { return false; }
      })!;
      expect(JSON.parse(readFileSync(restoreFile, 'utf8')).phase).toBe('cutover-intent');
      await invoke('rollback', '--to-legacy-b01', '--resume', restoreFile, '--yes', ...common);
      expect(realpathSync(join(home, 'current'))).toBe(realpathSync(source));
      const after = await container.exec(['psql', '-U', 'fixture', '-d', 'legacy_cli', '-At', '-c',
        "SELECT count(*) FROM public.platform_migrations; SELECT name FROM catalog_products WHERE sku = 'legacy-rollback'; SELECT to_regclass('public.platform_release_history') IS NULL AND to_regclass('public.platform_migration_baselines') IS NULL; SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='platform_migrations'"]);
      expect(after.exitCode, after.output).toBe(0);
      expect(after.stdout.trim()).toBe('49\nOriginal\nt\n3');
      const shadow = await container.exec(['psql', '-U', 'fixture', '-d', 'legacy_cli', '-At', '-c', "SELECT to_regclass('trap.platform_migrations') IS NULL"]);
      expect(shadow.stdout.trim()).toBe('t');
      await expectLegacyApi(source, env, port);
      return;
    }
    writeFileSync(join(root, 'fail-migrate'), '');
    await expect(run('--safety', safety, '--checksum', checksum, ...catalog, ...common)).rejects.toMatchObject({ stderr: expect.stringContaining('Release CLI failed') });
    const journalFile = readdirSync(operations).map(id => join(operations, id, 'bridge.json')).find(path => {
      try { const journal = JSON.parse(readFileSync(path, 'utf8')); return journal.kind === 'legacy-b01-bridge' && journal.phase === 'migrating'; } catch { return false; }
    })!;
    expect((await readLegacyBridgeJournal(journalFile, operations)).journal.phase).toBe('migrating');
    expect(realpathSync(join(home, 'current'))).toBe(realpathSync(source));
    await expect(run('--safety', safety, '--checksum', checksum, '--from-legacy-b01', '--catalog',
      'legacy-commerce-0.1.0-pre-b02', '--evidence', 'different evidence', ...common))
      .rejects.toMatchObject({ stderr: expect.stringContaining('baseline evidence is incomplete') });
    expect(realpathSync(join(home, 'current'))).toBe(realpathSync(source));
    const replacement = readdirSync(operations).map(id => join(operations, id, 'bridge.json')).find(path => {
      try { return JSON.parse(readFileSync(path, 'utf8')).evidence === 'different evidence'; } catch { return false; }
    })!;
    const rejected = await readLegacyBridgeJournal(replacement, operations);
    expect(rejected.journal.phase).toBe('safety');
    expect(rejected.snapshot).toBeNull();
    await expect(run('--safety', safety, '--checksum', checksum, ...catalog, ...common))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Release CLI failed') });
    rmSync(join(root, 'fail-migrate'));
    for (const point of ['before', 'after']) {
      writeFileSync(join(root, 'current-crash'), point);
      await expectSigkill(run('--from-legacy-b01', '--resume', journalFile, ...common));
      expect((await readLegacyBridgeJournal(journalFile, operations)).journal.phase).toBe('migrated');
      expect(realpathSync(join(home, 'current'))).toBe(realpathSync(point === 'before' ? source : join(home, 'releases', '0.2.0')));
    }
    rmSync(join(root, 'current-crash'));
    await run('--from-legacy-b01', '--resume', journalFile, ...common);
    expect((await readLegacyBridgeJournal(journalFile, operations)).journal.phase).toBe('activated');
    expect(realpathSync(join(home, 'current'))).toBe(realpathSync(join(home, 'releases', '0.2.0')));
    await run('--from-legacy-b01', '--resume', journalFile, ...common);
    const history = await container.exec(['psql', '-U', 'fixture', '-d', 'legacy_cli', '-At', '-c', 'SELECT release_version FROM public.platform_release_history ORDER BY sequence']);
    expect(history.stdout.trim()).toBe('0.1.0\n0.2.0');
    const bridge = await readLegacyBridgeJournal(journalFile, operations);
    const pair = bridge.snapshot!;
    const rollback = ['--snapshot', pair.directory, '--checksum', pair.manifestChecksum, '--yes', ...common];
    await expect(invoke('rollback', ...rollback)).rejects.toMatchObject({ code: 1 });
    const changed = await container.exec(['psql', '-U', 'fixture', '-d', 'legacy_cli', '-c', "UPDATE catalog_products SET name = 'Candidate' WHERE sku = 'legacy-rollback'"]);
    expect(changed.exitCode, changed.output).toBe(0);
    writeFileSync(join(root, 'pending-status'), '');
    await expect(invoke('rollback', '--to-legacy-b01', ...rollback)).rejects.toMatchObject({ stderr: expect.stringContaining('pending migrations or invalid status') });
    rmSync(join(root, 'pending-status'));
    expect(realpathSync(join(home, 'current'))).toBe(realpathSync(join(home, 'releases', '0.2.0')));
    const unchangedOid = await container.exec(['psql', '-U', 'fixture', '-d', 'legacy_cli', '-At', '-c', "SELECT oid::text FROM pg_catalog.pg_database WHERE datname = 'legacy_cli'"]);
    expect(unchangedOid.stdout.trim()).toBe(pair.manifest.evidence.database.oid);

    writeFileSync(join(root, 'rollback-crash'), '');
    await expectSigkill(invoke('rollback', '--to-legacy-b01', ...rollback));
    rmSync(join(root, 'rollback-crash'));
    const restoreFile = readdirSync(operations).map(id => join(operations, id, 'journal.json')).find(path => {
      try { const journal = JSON.parse(readFileSync(path, 'utf8')); return journal.kind === 'legacy-b01-restore' && journal.phase === 'cutover-intent'; } catch { return false; }
    })!;
    expect(JSON.parse(readFileSync(restoreFile, 'utf8')).phase).toBe('cutover-intent');
    expect(realpathSync(join(home, 'current'))).toBe(realpathSync(join(home, 'releases', '0.2.0')));
    await expect(invoke('rollback', '--resume', restoreFile, '--yes', ...common)).rejects.toMatchObject({ stderr: expect.stringContaining('matching explicit legacy mode') });
    await invoke('rollback', '--to-legacy-b01', '--resume', restoreFile, '--yes', ...common);
    expect(realpathSync(join(home, 'current'))).toBe(realpathSync(source));
    expect(JSON.parse(readFileSync(restoreFile, 'utf8')).phase).toBe('cutover-committed');
    const restored = await container.exec(['psql', '-U', 'fixture', '-d', 'legacy_cli', '-At', '-c',
      "SELECT release_version FROM public.platform_release_history; SELECT name FROM catalog_products WHERE sku = 'legacy-rollback'; SELECT historical_sql_verified, historical_runtime_verified FROM public.platform_migration_baselines"]);
    expect(restored.exitCode, restored.output).toBe(0);
    expect(restored.stdout.trim()).toBe('0.1.0\nOriginal\nf|f');
    const shadow = await container.exec(['psql', '-U', 'fixture', '-d', 'legacy_cli', '-At', '-c', "SELECT to_regclass('trap.platform_migrations') IS NULL"]);
    expect(shadow.stdout.trim()).toBe('t');
    await expectLegacyApi(source, env, port);
  } finally { await container.stop(); rmSync(root, { recursive: true, force: true }); }
});

async function expectLegacyApi(source: string, env: NodeJS.ProcessEnv, port: number) {
    if (env.STOREWEAVE_B01_CLI_FIXTURE) {
      const api = spawn(process.execPath, [join(source, 'app/api.js')], { env, stdio: 'ignore' });
      const exited = once(api, 'exit');
      try {
        const deadline = Date.now() + 15000;
        let healthy = false;
        while (Date.now() < deadline && api.exitCode === null) {
          try { healthy = (await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(1000) })).status === 200; } catch {}
          if (healthy) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        expect(healthy).toBe(true);
      } finally {
        api.kill('SIGTERM');
        const force = setTimeout(() => api.kill('SIGKILL'), 5000);
        try { expect((await exited)[0]).toBe(0); } finally { clearTimeout(force); }
      }
    }


}

async function expectSigkill(command: Promise<unknown>) {
  try {
    await command;
  } catch (error) {
    const result = error as { code?: number | null; signal?: string | null; killed?: boolean; stderr?: string };
    if (result.signal === 'SIGKILL') return;
    throw new Error(`Expected SIGKILL; received signal=${result.signal ?? 'null'}, code=${result.code ?? 'null'}, killed=${result.killed ?? false}, stderr=${JSON.stringify(result.stderr ?? '')}`);
  }
  throw new Error('Expected SIGKILL, but CLI exited successfully');
}
