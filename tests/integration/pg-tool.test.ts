import { requireUpgradeDatabase } from '../../tools/cli/src/upgrade-journal';
import { resumeRestoreCutover } from '../../tools/cli/src/resume-restore';
import { execFileSync } from 'node:child_process';
import { verifySourceRuntime } from '../../tools/cli/src/verify-source-runtime';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { expect, it, vi } from 'vitest';
import { verifyRestoredDatabase } from '../../tools/cli/src/verify-restored-database';
import { readRestoreJournal, writeRestoreJournal } from '../../tools/cli/src/restore-journal';
import { restoreSnapshotToScratch } from '../../tools/cli/src/restore-release-snapshot';
import { readPairedSnapshot } from '../../tools/cli/src/read-release-snapshot';
import { createPairedSnapshot } from '../../tools/cli/src/release-snapshot';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { release } from '../../packages/platform/bundle/src/releases/base';
import { buildReleaseManifest } from '../../packages/platform/bundle/src/release-manifest';
import { catalogDigest } from '@storeweave/db';
import type { Runtime } from '@storeweave/kernel';
import { writeNativeRelease } from '../unit/fixtures/native-release';

it('authenticates real pg_dump/pg_restore through private passfiles and retains object ownership and grants', async () => {
  const password = 'native:pass\\word';
  const container = await new PostgreSqlContainer('postgres:17-alpine').withDatabase('source_test')
    .withUsername('commerce').withPassword(password).start();
  const directory = mkdtempSync(join(tmpdir(), 'storeweave-native-pg-'));
  let runtime: Runtime | undefined;
  try {
    const setup = await container.exec(['psql', '-U', 'commerce', '-d', 'source_test', '-v', 'ON_ERROR_STOP=1', '-c', `
      CREATE ROLE fixture_intruder LOGIN PASSWORD 'intruder-password'; CREATE ROLE fixture_leaf; CREATE ROLE fixture_owner; CREATE ROLE fixture_reader;
      CREATE SCHEMA retained AUTHORIZATION fixture_owner;
      CREATE TABLE retained.probe (id integer); INSERT INTO retained.probe VALUES (7);
      ALTER TABLE retained.probe OWNER TO fixture_owner;
      GRANT USAGE ON SCHEMA retained TO fixture_reader;
      GRANT SELECT ON retained.probe TO fixture_reader;
      ALTER DEFAULT PRIVILEGES FOR ROLE fixture_owner IN SCHEMA retained GRANT SELECT ON TABLES TO fixture_reader;
    `]);
    expect(setup.exitCode, setup.output).toBe(0);
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    // Host has no pg client. Each adapter mounts only this test tree and its one private passfile directory.
    for (const tool of ['pg_dump', 'pg_restore']) writeFileSync(join(bin, tool), `#!/usr/bin/env node
      const { execFileSync } = require('node:child_process');
      const { dirname } = require('node:path');
      const args = process.argv.slice(2), index = args.indexOf('--dbname') + 1;
      if (index > 0) { const url = new URL(args[index]); url.hostname = 'host.docker.internal'; args[index] = url.toString(); }
      if (${JSON.stringify(tool)} === 'pg_restore' && !args.includes('--list')) {
        const fs = require('node:fs'), path = require('node:path');
        const root = ${JSON.stringify(join(directory, '.transitions'))};
        const journal = fs.readdirSync(root).map(id => JSON.parse(fs.readFileSync(path.join(root, id, 'journal.json'), 'utf8')))
          .find(entry => entry.scratch.name === new URL(args[index]).pathname.slice(1));
        if (!journal || journal.phase !== 'created' || !journal.scratch.oid) throw Error('Missing durable created journal before restore');
        const attempted = require('node:child_process').spawnSync('docker', ['exec', '--env', 'PGPASSWORD=intruder-password',
          ${JSON.stringify(container.getId())}, 'psql', '-h', '127.0.0.1', '-U', 'fixture_intruder', '-d', journal.scratch.name, '-At', '-c', 'SELECT 1'], { encoding: 'utf8' });
        if (attempted.status === 0 || !attempted.stderr.includes('too many connections for database')) throw Error('Scratch accepted ordinary connections');
      }
      if (${JSON.stringify(tool)} === 'pg_restore' && !args.includes('--list') && require('node:fs').existsSync(${JSON.stringify(join(directory, 'fail-restore'))})) process.exit(2);
      const credentials = process.env.PGPASSFILE ? ['--env', 'PGPASSFILE=' + process.env.PGPASSFILE,
        '--mount', 'type=bind,source=' + dirname(process.env.PGPASSFILE) + ',target=' + dirname(process.env.PGPASSFILE) + ',readonly'] : [];
      try {
        execFileSync('docker', ['run', '--rm', '--add-host', 'host.docker.internal:host-gateway', ...credentials,
          '--mount', ${JSON.stringify(`type=bind,source=${directory},target=${directory}`)},
          '--entrypoint', ${JSON.stringify(tool)}, 'postgres:17-alpine', ...args], { stdio: 'inherit' });
        if (${JSON.stringify(tool)} === 'pg_restore' && !args.includes('--list') && require('node:fs').existsSync(${JSON.stringify(join(directory, 'mutate-dump'))})) {
          require('node:fs').appendFileSync(args.at(-1), 'changed after native restore');
        }
      } catch (error) { process.exitCode = error.status || 1; }
    `, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.stubEnv('SW_SIGNING_KEY_TEST', Buffer.alloc(32, 3).toString('base64url'));
    const url = new URL(container.getConnectionUri());
    url.password = password;
    const config = join(directory, 'base.json');
    writeFileSync(config, JSON.stringify({ version: 1, store: { id: 'snapshot', name: 'Snapshot' },
      database: { url: url.toString() }, extensions: [], logging: { level: 'error' },
      security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] } }));
    runtime = (await bootstrapRelease(release, { configPath: config, loggerName: 'paired-snapshot-test' })).runtime;
    await runtime.migrate();
    await runtime.database.pool.query(`
      GRANT CONNECT ON DATABASE source_test TO fixture_reader WITH GRANT OPTION;
      SET ROLE fixture_reader; GRANT CONNECT ON DATABASE source_test TO fixture_leaf; RESET ROLE;
      ALTER DATABASE source_test CONNECTION LIMIT 42;
      COMMENT ON DATABASE source_test IS 'paired metadata';
      ALTER DATABASE source_test SET search_path TO 'has,comma', 'quote"name', 'semi; SELECT 1', retained, public;
      ALTER ROLE fixture_owner IN DATABASE source_test SET statement_timeout TO '1ms';
      ALTER ROLE fixture_owner IN DATABASE source_test SET transaction_read_only TO on;
      ALTER ROLE fixture_owner IN DATABASE source_test SET app.message TO 'a''b, c';
      SELECT set_config('temp_tablespaces', '', false);
      ALTER ROLE fixture_leaf IN DATABASE source_test SET temp_tablespaces FROM CURRENT;
    `);
    // The retained source CLI is a real build; remaining application entries are structural fixtures.
    const sourceDirectory = join(directory, 'source-release');
    const candidateDirectory = join(directory, 'candidate-release');
    for (const [target, version] of [[sourceDirectory, release.version], [candidateDirectory, '99.0.0']]) {
      writeNativeRelease(target!, 'base', version!);
      const manifest = buildReleaseManifest({ ...release, version: version! });
      writeFileSync(join(target!, 'release-manifest.json'), JSON.stringify(manifest));
      writeFileSync(join(target!, 'build-info.json'), JSON.stringify({ releaseId: 'base', version, manifestChecksum: catalogDigest(manifest) }));
    }
    const buildDirectory = join(directory, 'source-build');
    execFileSync(process.execPath, ['scripts/build.mjs'], { env: { ...process.env, STOREWEAVE_RELEASE: 'base',
      STOREWEAVE_RELEASE_VERSION: release.version, STOREWEAVE_BUILD_DIR: buildDirectory }, timeout: 60_000, stdio: 'pipe' });
    copyFileSync(join(buildDirectory, 'app/cli.js'), join(sourceDirectory, 'app/cli.js'));
    copyFileSync(process.execPath, join(sourceDirectory, 'runtime/bin/node'));
    const paired = await createPairedSnapshot({ databaseUrl: url.toString(), sourceDirectory, candidateDirectory,
      snapshotDirectory: join(directory, 'snapshots') }, callback => runtime!.withReleaseSnapshot(callback));
    const checked = await readPairedSnapshot(paired.directory, paired.manifestChecksum);
    await requireUpgradeDatabase(checked, url.toString());
    const dump = checked.dump;
    expect(paired.manifest.evidence.release.releaseId).toBe('base');
    expect(JSON.parse(readFileSync(join(paired.directory, 'snapshot.json'), 'utf8'))).toEqual(paired.manifest);
    expect(statSync(dump).mode & 0o777).toBe(0o600);
    expect(readFileSync(dump).subarray(0, 5).toString()).toBe('PGDMP');
    url.pathname = '/postgres';
    const journalDirectory = join(directory, '.transitions');
    mkdirSync(journalDirectory, { mode: 0o700 });
    const insecure = join(directory, 'insecure-journals');
    mkdirSync(insecure, { mode: 0o755 });
    await expect(restoreSnapshotToScratch(paired.directory, paired.manifestChecksum, url.toString(), insecure)).rejects.toThrow('owned 0700');
    const linked = join(directory, 'linked-journals');
    symlinkSync(journalDirectory, linked);
    await expect(restoreSnapshotToScratch(paired.directory, paired.manifestChecksum, url.toString(), linked)).rejects.toThrow('owned 0700');
    let malformed = '';
    try { await restoreSnapshotToScratch(paired.directory, paired.manifestChecksum, 'postgres://user:sentinel-secret@ bad/db', journalDirectory); }
    catch (error) { malformed = String(error); }
    expect(malformed).toContain('Invalid maintenance database URL');
    expect(malformed).not.toContain('sentinel-secret');
    const descriptorFile = join(paired.directory, 'snapshot.json');
    const originalDescriptor = readFileSync(descriptorFile, 'utf8');
    const oldVersion = JSON.parse(originalDescriptor);
    oldVersion.evidence.database.serverVersion = '16.9';
    writeFileSync(descriptorFile, JSON.stringify(oldVersion));
    try { await expect(restoreSnapshotToScratch(paired.directory, catalogDigest(oldVersion), url.toString(), journalDirectory)).rejects.toThrow('PostgreSQL 17'); }
    finally { writeFileSync(descriptorFile, originalDescriptor); }
    const before = await container.exec(['psql', '-U', 'commerce', '-d', 'postgres', '-At', '-c', "SELECT count(*) FROM pg_database WHERE datname LIKE 'storeweave_restore_%'"]);
    expect(before.stdout.trim()).toBe('0');
    const scratch = await restoreSnapshotToScratch(paired.directory, paired.manifestChecksum, url.toString(), journalDirectory);
    expect((await readRestoreJournal(scratch.journalFile, journalDirectory)).journal).toMatchObject({ phase: 'restored',
      snapshot: { checksum: paired.manifestChecksum }, scratch: { name: scratch.name, oid: scratch.oid } });
    expect(statSync(scratch.journalFile).mode & 0o777).toBe(0o600);
    const verifiedUrl = new URL(url);
    verifiedUrl.pathname = `/${scratch.name}`;
    expect(await verifyRestoredDatabase(paired.directory, paired.manifestChecksum, verifiedUrl.toString(), scratch.oid))
      .toEqual({ name: scratch.name, oid: scratch.oid, systemIdentifier: scratch.systemIdentifier });
    await expect(verifyRestoredDatabase(paired.directory, paired.manifestChecksum, verifiedUrl.toString(), '1')).rejects.toThrow('identity or properties');
    for (const key of ['host', 'port', 'database', 'dbname']) {
      const routed = new URL(verifiedUrl);
      routed.searchParams.set(key, key === 'port' ? '1' : 'override');
      await expect(verifyRestoredDatabase(paired.directory, paired.manifestChecksum, routed.toString(), scratch.oid))
        .rejects.toThrow('Invalid verification database URL');
    }
    await verifySourceRuntime(paired.directory, paired.manifestChecksum, config, verifiedUrl.toString());
    const shadow = await container.exec(['psql', '-U', 'commerce', '-d', scratch.name, '-At', '-c', "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'retained' AND tablename LIKE 'platform_%'"]);
    expect(shadow.stdout.trim()).toBe('0');
    // Cold source execution must leave the captured properties/history/sequence unchanged.
    await verifyRestoredDatabase(paired.directory, paired.manifestChecksum, verifiedUrl.toString(), scratch.oid);
    const missingDatabase = new URL(verifiedUrl);
    missingDatabase.pathname = '/missing_runtime_database';
    await expect(verifySourceRuntime(paired.directory, paired.manifestChecksum, config, missingDatabase.toString()))
      .rejects.toThrow('Retained source runtime verification failed');


    const properties = await container.exec(['psql', '-U', 'commerce', '-d', 'postgres', '-At', '-c',
      `SELECT datconnlimit, shobj_description(oid, 'pg_database'), pg_get_userbyid(datdba) FROM pg_database WHERE datname = '${scratch.name}'`]);
    expect(properties.exitCode, properties.output).toBe(0);
    expect(properties.stdout.trim()).toBe('42|paired metadata|commerce');
    const restored = await container.exec(['psql', '-U', 'commerce', '-d', scratch.name, '-At', '-c', `
      SELECT id, pg_get_userbyid(c.relowner), has_table_privilege('fixture_reader', 'retained.probe', 'SELECT'),
        (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'retained'),
        has_schema_privilege('fixture_reader', 'retained', 'USAGE'),
        (SELECT string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) FROM pg_default_acl d,
          LATERAL aclexplode(d.defaclacl) a WHERE d.defaclrole = 'fixture_owner'::regrole
          AND d.defaclnamespace = 'retained'::regnamespace AND d.defaclobjtype = 'r'
          AND a.grantee = 'fixture_reader'::regrole AND a.grantor = 'fixture_owner'::regrole AND NOT a.is_grantable)
      FROM retained.probe, pg_class c WHERE c.oid = 'retained.probe'::regclass;
    `]);
    expect(restored.exitCode, restored.output).toBe(0);
    expect(restored.stdout.trim()).toBe('7|fixture_owner|t|fixture_owner|t|SELECT');
    const history = await container.exec(['psql', '-U', 'commerce', '-d', scratch.name, '-At', '-c', `
      SET TIME ZONE 'UTC'; SET DateStyle = 'ISO, YMD';
      SELECT jsonb_build_object('history', (SELECT jsonb_agg(to_jsonb(r) || jsonb_build_object('sequence', sequence::text) ORDER BY sequence) FROM platform_release_history r),
        'migrations', (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM platform_migrations m),
        'generator', (SELECT jsonb_build_object('lastValue', last_value::text, 'isCalled', is_called) FROM platform_release_history_sequence_seq));
    `]);
    expect(history.exitCode, history.output).toBe(0);
    const state = JSON.parse(history.stdout.trim().split('\n').at(-1)!);
    expect(catalogDigest(state.history)).toBe(paired.manifest.evidence.historyChecksum);
    expect(catalogDigest(state.migrations)).toBe(paired.manifest.evidence.migrationsChecksum);
    expect(state.generator).toEqual(paired.manifest.evidence.historySequence);
    const changedHistory = await container.exec(['psql', '-U', 'commerce', '-d', scratch.name, '-At', '-c',
      "UPDATE public.platform_migrations SET applied_at = applied_at + interval '1 microsecond' WHERE id = (SELECT min(id) FROM public.platform_migrations)"]);
    expect(changedHistory.exitCode, changedHistory.output).toBe(0);
    await expect(verifyRestoredDatabase(paired.directory, paired.manifestChecksum, verifiedUrl.toString(), scratch.oid)).rejects.toThrow('history mismatch');
    const changedProperties = await container.exec(['psql', '-U', 'commerce', '-d', 'postgres', '-At', '-c', `ALTER DATABASE "${scratch.name}" CONNECTION LIMIT 41`]);
    expect(changedProperties.exitCode, changedProperties.output).toBe(0);
    await expect(verifyRestoredDatabase(paired.directory, paired.manifestChecksum, verifiedUrl.toString(), scratch.oid)).rejects.toThrow('identity or properties');

    const clearedHistory = await container.exec(['psql', '-U', 'commerce', '-d', scratch.name, '-At', '-c', 'DELETE FROM public.platform_release_history']);
    expect(clearedHistory.exitCode, clearedHistory.output).toBe(0);
    await expect(verifySourceRuntime(paired.directory, paired.manifestChecksum, config, verifiedUrl.toString()))
      .rejects.toThrow('does not match the restored database');

    const originalDump = readFileSync(dump);
    writeFileSync(join(directory, 'mutate-dump'), '');
    try { await expect(restoreSnapshotToScratch(paired.directory, paired.manifestChecksum, url.toString(), journalDirectory)).rejects.toThrow('Snapshot dump size mismatch'); }
    finally { writeFileSync(dump, originalDump); rmSync(join(directory, 'mutate-dump')); }
    writeFileSync(join(directory, 'fail-restore'), '');
    await expect(restoreSnapshotToScratch(paired.directory, paired.manifestChecksum, url.toString(), journalDirectory)).rejects.toThrow('pg_restore failed');
    const journals = readdirSync(journalDirectory).map(id => JSON.parse(readFileSync(join(journalDirectory, id, 'journal.json'), 'utf8')));
    const failed = journals.find(entry => entry.phase === 'failed' && entry.scratch.oid !== null);
    expect(failed.scratch.oid).toMatch(/^\d+$/);
    const retained = await container.exec(['psql', '-U', 'commerce', '-d', 'postgres', '-At', '-c',
      `SELECT datname, oid::text FROM pg_database WHERE datname IN ('source_test', '${failed.scratch.name}') ORDER BY datname`]);
    expect(retained.exitCode, retained.output).toBe(0);
    expect(retained.stdout).toContain(`source_test|${paired.manifest.evidence.database.oid}`);
    expect(retained.stdout).toContain(`${failed.scratch.name}|${failed.scratch.oid}`);

    rmSync(join(directory, 'fail-restore'));
    const ready = await restoreSnapshotToScratch(paired.directory, paired.manifestChecksum, url.toString(), journalDirectory);
    await runtime.close();
    runtime = undefined;
    const intentJournal = (await readRestoreJournal(ready.journalFile, journalDirectory)).journal;
    await expect(resumeRestoreCutover(await readRestoreJournal(join(journalDirectory, failed.id, 'journal.json'), journalDirectory), url.toString(), config))
      .rejects.toThrow('no completed scratch database');
    writeRestoreJournal(ready.journalFile, { ...intentJournal, phase: 'cutover-committed' }, journalDirectory);
    await expect(resumeRestoreCutover(await readRestoreJournal(ready.journalFile, journalDirectory), url.toString(), config)).rejects.toThrow('initial database mapping');
    writeRestoreJournal(ready.journalFile, intentJournal, journalDirectory);

    const cliHome = directory;
    symlinkSync(candidateDirectory, join(cliHome, 'current'));
    // macOS orchestration shim only; real flock is covered by the Linux native guard test.
    writeFileSync(join(bin, 'flock'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
    writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const rollbackOutput = execFileSync(process.execPath, [join(buildDirectory, 'app/cli.js'), 'rollback',
      '--resume', ready.journalFile, '--yes', '--external-writers-stopped', '--no-restart'], {
      env: { ...process.env, STOREWEAVE_CONFIG: config, STOREWEAVE_HOME: cliHome,
        STOREWEAVE_DATA_DIR: join(directory, 'cli-data'), STOREWEAVE_LOG_DIR: join(directory, 'cli-logs') },
      encoding: 'utf8', timeout: 60_000, stdio: 'pipe' });
    expect(rollbackOutput).toContain(`current -> ${sourceDirectory}`);
    expect(readlinkSync(join(cliHome, 'current'))).toBe(sourceDirectory);
    const cutover = { sourceDirectory, journalFile: ready.journalFile, quarantineName: intentJournal.quarantineName };
    expect(cutover.sourceDirectory).toBe(sourceDirectory);
    expect((await readRestoreJournal(ready.journalFile, journalDirectory)).journal.phase).toBe('cutover-committed');
    writeRestoreJournal(ready.journalFile, intentJournal, journalDirectory);
    await expect(resumeRestoreCutover(await readRestoreJournal(ready.journalFile, journalDirectory), url.toString(), config)).rejects.toThrow('no durable cutover intent');
    // Simulate a durable intent surviving but its post-COMMIT progress write being lost.
    writeRestoreJournal(ready.journalFile, { ...intentJournal, phase: 'cutover-intent' }, journalDirectory);
    expect(await resumeRestoreCutover(await readRestoreJournal(ready.journalFile, journalDirectory), url.toString(), config)).toEqual(cutover);
    const cutoverMap = await container.exec(['psql', '-U', 'commerce', '-d', 'postgres', '-At', '-c',
      `SELECT datname, oid::text FROM pg_catalog.pg_database WHERE datname IN ('source_test', '${ready.name}', '${cutover.quarantineName}') ORDER BY datname`]);
    expect(cutoverMap.exitCode, cutoverMap.output).toBe(0);
    expect(cutoverMap.stdout).toContain(`source_test|${ready.oid}`);
    expect(cutoverMap.stdout).toContain(`${cutover.quarantineName}|${paired.manifest.evidence.database.oid}`);
    expect(cutoverMap.stdout).not.toContain(`${ready.name}|`);
    const replacedLive = new URL(url);
    replacedLive.pathname = '/source_test';
    await expect(requireUpgradeDatabase(checked, replacedLive.toString())).rejects.toThrow('identity differs');


  } finally {
    vi.unstubAllEnvs();
    await runtime?.close();
    await container.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
