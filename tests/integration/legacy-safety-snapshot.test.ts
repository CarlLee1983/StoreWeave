import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { expect, it, vi } from 'vitest';
import { baselineMigrations, runMigrations, catalogDigest, legacyBaselineSelection } from '@storeweave/db';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { release } from '../../packages/platform/bundle/src/releases/commerce';
import { verifyLegacySafetyDatabase, verifyLegacyRestoredDatabase } from '../../tools/cli/src/verify-restored-database';
import { createLegacyBridgeJournal, readLegacyBridgeJournal, advanceLegacyBridgeJournal } from '../../tools/cli/src/legacy-bridge-journal';
import { createLegacyPairedSnapshot, readLegacyPairedSnapshot } from '../../tools/cli/src/legacy-paired-snapshot';
import baseline from '../../packages/platform/bundle/src/legacy/commerce-pre-b02.json';
import { createLegacySafetySnapshot, readLegacySafetySnapshot } from '../../tools/cli/src/legacy-safety-snapshot';
import { runPgTool } from '../../tools/cli/src/pg-tool';
import { writeNativeRelease } from '../unit/fixtures/native-release';

it('publishes a native B01 safety dump without baseline DDL and preserves raw history on failure', async () => {
  const container = await new PostgreSqlContainer('postgres:17-alpine').withDatabase('legacy_source').withUsername('fixture').withPassword('fixture').start();
  const root = mkdtempSync(join(tmpdir(), 'storeweave-legacy-safety-'));
  const pool = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  const configPath = join(root, 'config.json');
  process.env.SW_SIGNING_KEY_TEST = Buffer.alloc(32, 3).toString('base64url');
  writeFileSync(configPath, JSON.stringify({ version: 1, store: { id: 'legacy-test', name: 'Legacy test' }, database: { url: container.getConnectionUri() }, extensions: [],
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] } }));
  const { runtime } = await bootstrapRelease(release, { configPath, loggerName: 'legacy-test', logDestination: 'stderr' });
  try {
    // Execute the pinned B01 catalog, then retain the historical three-column ledger shape.
    const legacySource = legacyBaselineSelection(baseline, runtime.migrations);
    await runMigrations(pool, legacySource.migrations);
    const columns = await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='platform_migrations'");
    for (const { column_name } of columns.rows) if (!['id', 'phase', 'applied_at'].includes(column_name)) {
      await pool.query(`ALTER TABLE public.platform_migrations DROP COLUMN "${column_name.replaceAll('"', '""')}"`);
    }
    await pool.query('DROP TABLE public.platform_release_history; DROP TABLE public.platform_migration_baselines');
    await pool.query('CREATE TABLE legacy_probe (id integer); INSERT INTO legacy_probe VALUES (7)');
    const source = join(root, 'source'), candidate = join(root, 'candidate'), operations = join(root, 'operations'), bin = join(root, 'bin');
    writeNativeRelease(source, 'commerce', '0.1.0'); writeNativeRelease(candidate, 'commerce', '0.2.0');
    for (const file of ['RELEASE', 'release-manifest.json', 'scripts/validate-release.js', 'app/seed.js']) rmSync(join(source, file));
    writeFileSync(join(source, 'build-info.json'), JSON.stringify({ version: '0.1.0', builtOnNode: 'v22.17.1', entries: ['/dist/app/api.js', '/dist/app/worker.js', '/dist/app/cli.js'] }));
    mkdirSync(operations, { mode: 0o700 }); mkdirSync(bin);
    for (const tool of ['pg_dump', 'pg_restore']) writeFileSync(join(bin, tool), `#!/usr/bin/env node
      const args = process.argv.slice(2), i = args.indexOf('--dbname') + 1, fs = require('node:fs');
      if (${JSON.stringify(tool)} === 'pg_dump' && fs.existsSync(${JSON.stringify(join(root, 'fail-dump'))})) process.exit(2);
      if (${JSON.stringify(tool)} === 'pg_dump' && fs.existsSync(${JSON.stringify(join(root, 'mutate-baseline'))})) {
        fs.unlinkSync(${JSON.stringify(join(root, 'mutate-baseline'))});
        require('node:child_process').execFileSync('docker', ['exec', ${JSON.stringify(container.getId())}, 'psql', '-U', 'fixture', '-d', 'legacy_source', '-c', "UPDATE public.platform_migration_baselines SET historical_sql_verified = true, source_release = 'changed-after-export'"]);
      }

      if (i) { const u = new URL(args[i]); u.hostname = 'host.docker.internal'; args[i] = u.toString(); }
      const pass = process.env.PGPASSFILE;
      const credentials = pass ? ['--env', 'PGPASSFILE=' + pass, '--mount', 'type=bind,source=' + require('node:path').dirname(pass) + ',target=' + require('node:path').dirname(pass) + ',readonly'] : [];
      try { require('node:child_process').execFileSync('docker', ['run', '--rm', '--add-host', 'host.docker.internal:host-gateway', ...credentials,
        '--mount', ${JSON.stringify(`type=bind,source=${root},target=${root}`)}, '--entrypoint', ${JSON.stringify(tool)}, 'postgres:17-alpine', ...args], { stdio: 'inherit' }); }
      catch (error) { process.exitCode = error.status || 1; }
    `, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    const options = { databaseUrl: container.getConnectionUri(), sourceDirectory: source, candidateDirectory: candidate, operationRoot: operations };
    const before = (await pool.query("SELECT jsonb_agg(to_jsonb(m) ORDER BY id) AS rows FROM public.platform_migrations m")).rows[0].rows;
    expect(before).toHaveLength(49);
    const safety = await createLegacySafetySnapshot(pool, options);
    expect(safety.manifest.evidence.migrationsChecksum).toBe(catalogDigest(before));
    expect(safety.manifest.kind).toBe('legacy-b01-safety');
    expect((await readLegacySafetySnapshot(safety.directory, safety.manifestChecksum)).manifest).toEqual(safety.manifest);
    expect(statSync(join(safety.directory, 'safety.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(safety.directory, 'database.dump')).subarray(0, 5).toString()).toBe('PGDMP');
    expect(readFileSync(join(safety.directory, 'safety.json'), 'utf8')).not.toContain('snapshotId');
    const shape = await pool.query("SELECT count(*)::int AS columns FROM information_schema.columns WHERE table_schema='public' AND table_name='platform_migrations'");
    expect(shape.rows[0].columns).toBe(3);
    expect((await pool.query("SELECT to_regclass('public.platform_release_history') AS history, to_regclass('public.platform_migration_baselines') AS baseline")).rows[0]).toEqual({ history: null, baseline: null });
    await pool.query('CREATE DATABASE legacy_restored TEMPLATE template0');
    const restored = new URL(container.getConnectionUri()); restored.pathname = '/legacy_restored';
    await runPgTool('pg_restore', restored.toString(), ['--exit-on-error', '--single-transaction', join(safety.directory, 'database.dump')]);
    const check = await container.exec(['psql', '-U', 'fixture', '-d', 'legacy_restored', '-At', '-c', 'SELECT count(*) FROM platform_migrations; SELECT id FROM legacy_probe']);
    expect(check.exitCode, check.output).toBe(0); expect(check.stdout.trim()).toBe('49\n7');
    const rawPool = new Pool({ connectionString: restored.toString(), max: 1 });
    try {
      const oid = (await rawPool.query('SELECT oid::text FROM pg_catalog.pg_database WHERE datname = current_database()')).rows[0].oid;
      await expect(verifyLegacySafetyDatabase(safety.directory, safety.manifestChecksum, restored.toString(), oid)).resolves.toMatchObject({ oid });
      await rawPool.query("UPDATE public.platform_migrations SET applied_at = applied_at + interval '1 microsecond'");
      await expect(verifyLegacySafetyDatabase(safety.directory, safety.manifestChecksum, restored.toString(), oid)).rejects.toThrow('raw migration history mismatch');
      await rawPool.query("UPDATE public.platform_migrations SET applied_at = applied_at - interval '1 microsecond'");
      for (const table of ['platform_release_history', 'platform_migration_baselines']) {
        await rawPool.query(`CREATE TABLE public.${table}(id integer)`);
        await expect(verifyLegacySafetyDatabase(safety.directory, safety.manifestChecksum, restored.toString(), oid)).rejects.toThrow('unadopted three-column');
        await rawPool.query(`DROP TABLE public.${table}`);
      }
      await rawPool.query('ALTER TABLE public.platform_migrations ADD COLUMN checksum text');
      await expect(verifyLegacySafetyDatabase(safety.directory, safety.manifestChecksum, restored.toString(), oid)).rejects.toThrow('unadopted three-column');
      await rawPool.query('ALTER TABLE public.platform_migrations DROP COLUMN checksum');
      await expect(verifyLegacySafetyDatabase(safety.directory, safety.manifestChecksum, restored.toString(), oid)).resolves.toMatchObject({ oid });
    } finally { await rawPool.end(); }

    writeFileSync(join(root, 'fail-dump'), '');
    await expect(createLegacySafetySnapshot(pool, options)).rejects.toThrow('pg_dump failed');
    expect(readdirSync(operations)).toEqual([safety.manifest.id]);
    expect((await pool.query('SELECT jsonb_agg(to_jsonb(m) ORDER BY id) AS rows FROM public.platform_migrations m')).rows[0].rows).toEqual(before);
    const descriptor = join(safety.directory, 'safety.json'), originalDescriptor = readFileSync(descriptor);
    writeFileSync(descriptor, '{}');
    await expect(readLegacySafetySnapshot(safety.directory, safety.manifestChecksum)).rejects.toThrow('descriptor checksum mismatch');
    writeFileSync(descriptor, originalDescriptor);
    const dumpFile = join(safety.directory, 'database.dump'), originalDump = readFileSync(dumpFile);
    writeFileSync(dumpFile, 'changed');
    await expect(readLegacySafetySnapshot(safety.directory, safety.manifestChecksum)).rejects.toThrow('dump size mismatch');
    writeFileSync(dumpFile, originalDump);
    const originalCli = readFileSync(join(source, 'app/cli.js'));
    writeFileSync(join(source, 'app/cli.js'), '// changed recovery code');
    await expect(readLegacySafetySnapshot(safety.directory, safety.manifestChecksum)).rejects.toThrow('recovery artifact changed');
    writeFileSync(join(source, 'app/cli.js'), originalCli);
    rmSync(join(root, 'fail-dump'));
    const bridgeFile = await createLegacyBridgeJournal(operations, safety.directory, safety.manifestChecksum, 'owned fixture baseline');
    expect((await readLegacyBridgeJournal(bridgeFile, operations)).journal.phase).toBe('safety');
    expect(statSync(bridgeFile).mode & 0o777).toBe(0o600);
    await expect(advanceLegacyBridgeJournal(bridgeFile, operations, 'migrating')).rejects.toThrow('Invalid bridge journal phase');
    const otherCandidate = join(root, 'other-candidate');
    writeNativeRelease(otherCandidate, 'commerce', '0.2.1');
    const otherSafety = await createLegacySafetySnapshot(pool, { ...options, candidateDirectory: otherCandidate });
    const adopted = await baselineMigrations(pool, runtime.migrations, baseline, 'owned fixture baseline');
    const pairOptions = { databaseUrl: container.getConnectionUri(), safetyDirectory: safety.directory,
      safetyChecksum: safety.manifestChecksum, operationRoot: operations, evidence: 'owned fixture baseline' };
    await expect(createLegacyPairedSnapshot(pool, runtime.migrations, { ...pairOptions, evidence: 'different operator evidence' })).rejects.toThrow('baseline evidence is incomplete');
    const beforeRecapture = readdirSync(operations).sort();
    await expect(createLegacySafetySnapshot(pool, options)).rejects.toThrow('unadopted three-column migration history');
    expect(readdirSync(operations).sort()).toEqual(beforeRecapture);
    await pool.query("UPDATE public.platform_migrations SET applied_at = applied_at + interval '1 microsecond'");
    await expect(createLegacyPairedSnapshot(pool, runtime.migrations, pairOptions)).rejects.toThrow('differs from raw safety snapshot');
    await pool.query("UPDATE public.platform_migrations SET applied_at = applied_at - interval '1 microsecond'");
    await pool.query("UPDATE public.platform_migration_baselines SET source_release = 'wrong-source'");
    await expect(createLegacyPairedSnapshot(pool, runtime.migrations, pairOptions)).rejects.toThrow('exact unverified baseline provenance');
    await pool.query('UPDATE public.platform_migration_baselines SET source_release = $1', [baseline.sourceRelease]);
    const migrationRow = (await pool.query('SELECT * FROM public.platform_migrations ORDER BY id LIMIT 1')).rows[0];
    for (const field of ['legacy_baseline_id', 'migration_owner', 'migration_id', 'module_id', 'module_version', 'release_id', 'release_version']) {
      await pool.query(`UPDATE public.platform_migrations SET ${field} = NULL WHERE id = $1`, [migrationRow.id]);
      await expect(createLegacyPairedSnapshot(pool, runtime.migrations, pairOptions)).rejects.toThrow('baseline association or provenance differs');
      await pool.query(`UPDATE public.platform_migrations SET ${field} = $1 WHERE id = $2`, [migrationRow[field], migrationRow.id]);
    }
    const pair = await createLegacyPairedSnapshot(pool, runtime.migrations, pairOptions);
    const otherPair = await createLegacyPairedSnapshot(pool, runtime.migrations, { ...pairOptions,
      safetyDirectory: otherSafety.directory, safetyChecksum: otherSafety.manifestChecksum });
    await expect(advanceLegacyBridgeJournal(bridgeFile, operations, 'paired', {
      directory: otherPair.directory, checksum: otherPair.manifestChecksum,
    })).rejects.toThrow('Bridge pair differs from its original safety snapshot');
    expect((await readLegacyBridgeJournal(bridgeFile, operations)).journal.phase).toBe('safety');
    expect(pair.manifest.baseline.id).toBe(adopted.baselineId);
    await advanceLegacyBridgeJournal(bridgeFile, operations, 'paired', { directory: pair.directory, checksum: pair.manifestChecksum });
    const recordedBridge = await readLegacyBridgeJournal(bridgeFile, operations);
    expect(recordedBridge.snapshot?.manifest.baseline.id).toBe(adopted.baselineId);
    for (const phase of ['migrating', 'migrated', 'activated'] as const) {
      await advanceLegacyBridgeJournal(bridgeFile, operations, phase);
    }
    await expect(advanceLegacyBridgeJournal(bridgeFile, operations, 'safety')).rejects.toThrow('Invalid bridge journal phase');
    const outside = join(root, 'outside', recordedBridge.journal.id);
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    const outsideFile = join(outside, 'bridge.json');
    writeFileSync(outsideFile, readFileSync(bridgeFile), { mode: 0o600 });
    await expect(readLegacyBridgeJournal(outsideFile, operations)).rejects.toThrow('outside the locked transition root');
    expect((await readLegacyPairedSnapshot(pair.directory, pair.manifestChecksum)).manifest).toEqual(pair.manifest);
    expect(pair.manifest.source).not.toHaveProperty('manifestChecksum');
    await pool.query('CREATE DATABASE paired_restored TEMPLATE template0');
    restored.pathname = '/paired_restored';
    await runPgTool('pg_restore', restored.toString(), ['--exit-on-error', '--single-transaction', join(pair.directory, 'database.dump')]);
    const pairedCheck = await container.exec(['psql', '-U', 'fixture', '-d', 'paired_restored', '-At', '-c',
      'SELECT count(*) FROM public.platform_migrations; SELECT historical_sql_verified, historical_runtime_verified FROM public.platform_migration_baselines; SELECT id FROM legacy_probe']);
    expect(pairedCheck.exitCode, pairedCheck.output).toBe(0);
    expect(pairedCheck.stdout.trim()).toBe('49\nf|f\n7');
    const restoredPool = new Pool({ connectionString: restored.toString(), max: 1 });
    try {
      const restoredOid = (await restoredPool.query("SELECT oid::text FROM pg_catalog.pg_database WHERE datname = current_database()")).rows[0].oid;
      await expect(verifyLegacyRestoredDatabase(pair.directory, pair.manifestChecksum, restored.toString(), restoredOid)).resolves.toMatchObject({ oid: restoredOid });
      await expect(verifyLegacyRestoredDatabase(pair.directory, pair.manifestChecksum, restored.toString(), '0')).rejects.toThrow('identity or properties mismatch');
      const originalBaseline = (await restoredPool.query('SELECT to_jsonb(b) AS entry FROM public.platform_migration_baselines b')).rows[0].entry;
      for (const [field, changed] of Object.entries({ historical_sql_verified: true, historical_runtime_verified: true,
        source_release: 'wrong source', catalog_checksum: 'wrong checksum', evidence: 'changed evidence' })) {
        await restoredPool.query(`UPDATE public.platform_migration_baselines SET ${field} = $1`, [changed]);
        await expect(verifyLegacyRestoredDatabase(pair.directory, pair.manifestChecksum, restored.toString(), restoredOid))
          .rejects.toThrow('baseline provenance mismatch');
        await restoredPool.query(`UPDATE public.platform_migration_baselines SET ${field} = $1`, [originalBaseline[field]]);
      }
      await restoredPool.query("UPDATE public.platform_migration_baselines SET accepted_at = accepted_at + interval '1 microsecond'");
      await expect(verifyLegacyRestoredDatabase(pair.directory, pair.manifestChecksum, restored.toString(), restoredOid)).rejects.toThrow('baseline provenance mismatch');
      await restoredPool.query('UPDATE public.platform_migration_baselines SET accepted_at = $1', [originalBaseline.accepted_at]);
      await restoredPool.query('UPDATE public.platform_migrations SET legacy_baseline_id = NULL');
      await expect(verifyLegacyRestoredDatabase(pair.directory, pair.manifestChecksum, restored.toString(), restoredOid)).rejects.toThrow('history mismatch');
      await restoredPool.query('UPDATE public.platform_migrations SET legacy_baseline_id = $1', [pair.manifest.baseline.id]);
      await expect(verifyLegacyRestoredDatabase(pair.directory, pair.manifestChecksum, restored.toString(), restoredOid)).resolves.toMatchObject({ oid: restoredOid });
    } finally { await restoredPool.end(); }

    writeFileSync(dumpFile, 'raw changed');
    await expect(readLegacyBridgeJournal(bridgeFile, operations)).rejects.toThrow('dump size mismatch');
    await expect(readLegacyPairedSnapshot(pair.directory, pair.manifestChecksum)).rejects.toThrow('dump size mismatch');
    writeFileSync(dumpFile, originalDump);
    const pairDump = join(pair.directory, 'database.dump'), originalPairDump = readFileSync(pairDump);
    writeFileSync(pairDump, 'pair changed');
    await expect(readLegacyPairedSnapshot(pair.directory, pair.manifestChecksum)).rejects.toThrow('dump size mismatch');
    writeFileSync(pairDump, originalPairDump);
    writeFileSync(join(root, 'fail-dump'), '');
    const beforeFailedDump = readdirSync(operations).sort();
    await expect(createLegacyPairedSnapshot(pool, runtime.migrations, pairOptions)).rejects.toThrow('pg_dump failed');
    expect(readdirSync(operations).sort()).toEqual(beforeFailedDump);
    rmSync(join(root, 'fail-dump'));
    await pool.query('UPDATE public.platform_migration_baselines SET historical_sql_verified = true');
    const beforeInvalidPair = readdirSync(operations).sort();
    await expect(createLegacyPairedSnapshot(pool, runtime.migrations, pairOptions)).rejects.toThrow('exact unverified baseline provenance');
    expect(readdirSync(operations).sort()).toEqual(beforeInvalidPair);
    await pool.query('UPDATE public.platform_migration_baselines SET historical_sql_verified = false');
    writeFileSync(join(root, 'mutate-baseline'), '');
    const concurrentPair = await createLegacyPairedSnapshot(pool, runtime.migrations, pairOptions);
    expect((await pool.query('SELECT source_release FROM public.platform_migration_baselines')).rows[0].source_release).toBe('changed-after-export');
    await pool.query('CREATE DATABASE concurrent_restored TEMPLATE template0');
    restored.pathname = '/concurrent_restored';
    await runPgTool('pg_restore', restored.toString(), ['--exit-on-error', '--single-transaction', join(concurrentPair.directory, 'database.dump')]);
    const concurrentBaseline = await container.exec(['psql', '-U', 'fixture', '-d', 'concurrent_restored', '-At', '-c',
      'SELECT to_jsonb(b) FROM public.platform_migration_baselines b']);
    expect(concurrentBaseline.exitCode, concurrentBaseline.output).toBe(0);
    const restoredBaseline = JSON.parse(concurrentBaseline.stdout.trim());
    expect(restoredBaseline.source_release).toBe(baseline.sourceRelease);
    expect(restoredBaseline.historical_sql_verified).toBe(false);
    expect(catalogDigest(restoredBaseline)).toBe(concurrentPair.manifest.baseline.checksum);



  } finally { vi.unstubAllEnvs(); await runtime.close(); await pool.end(); await container.stop(); rmSync(root, { recursive: true, force: true }); }
});
