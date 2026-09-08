import { build as bundle } from 'esbuild';
import { catalogDigest } from '@storeweave/db';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { expect, it } from 'vitest';
import { writeNativeRelease } from '../unit/fixtures/native-release';
import { readUpgradeJournal } from '../../tools/cli/src/upgrade-journal';

it('real CLI upgrades with a paired snapshot, retries the same candidate, and restores the source from that pair', async () => {
  const container = await new PostgreSqlContainer('postgres:17-alpine').withDatabase('paired_cli').withUsername('fixture').withPassword('fixture').start();
  const root = mkdtempSync(join(tmpdir(), 'storeweave-cli-pair-'));
  let service: ChildProcess | undefined;
  try {
    const home = join(root, 'home'), bin = join(root, 'bin');
    mkdirSync(join(home, 'releases'), { recursive: true }); mkdirSync(bin);
    // Host orchestration only; actual kernel flock is tested in the Linux native guard suite.
    writeFileSync(join(bin, 'flock'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
    writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    for (const tool of ['pg_dump', 'pg_restore']) writeFileSync(join(bin, tool), `#!/usr/bin/env node
      const args = process.argv.slice(2), i = args.indexOf('--dbname') + 1;
      if (i) { const u = new URL(args[i]); u.hostname = 'host.docker.internal'; args[i] = u.toString(); }
      if (${JSON.stringify(tool)} === 'pg_dump' && !require('node:fs').existsSync(${JSON.stringify(join(root, 'stopped'))})) throw Error('Dump ran before managed service stopped');
      if (${JSON.stringify(tool)} === 'pg_dump' && require('node:fs').existsSync(${JSON.stringify(join(root, 'fail-dump'))})) process.exit(24);
      const passfile = process.env.PGPASSFILE;
      const credentials = passfile ? ['--env', 'PGPASSFILE=' + passfile, '--mount', 'type=bind,source=' + require('node:path').dirname(passfile) + ',target=' + require('node:path').dirname(passfile) + ',readonly'] : [];
      try { require('node:child_process').execFileSync('docker', ['run', '--rm', ...credentials,
        '--mount', ${JSON.stringify(`type=bind,source=${root},target=${root}`)}, '--entrypoint', ${JSON.stringify(tool)}, 'postgres:17-alpine', ...args], { stdio: 'inherit' }); }
      catch (error) { process.exitCode = error.status || 1; }
    `, { mode: 0o755 });
    const source = join(home, 'releases', '0.2.0'), media = join(root, 'storeweave-0.2.1'), otherMedia = join(root, 'storeweave-0.2.2');
    for (const [target, version] of [[source, '0.2.0'], [media, '0.2.1'], [otherMedia, '0.2.2']]) {
      const build = join(root, `build-${version}`);
      execFileSync(process.execPath, ['scripts/build.mjs'], { env: { ...process.env, STOREWEAVE_RELEASE: 'base',
        STOREWEAVE_RELEASE_VERSION: version, STOREWEAVE_BUILD_DIR: build }, stdio: 'pipe', timeout: 60_000 });
      writeNativeRelease(target!, 'base', version!);
      for (const name of ['release-manifest.json', 'build-info.json', 'app/cli.js']) copyFileSync(join(build, name), join(target!, name));
      if (target !== source) {
        // Real bundled migration runner: both candidates share the first committed SQL,
        // but their second migration differs. No production build hook is needed.
        const selected = join(root, `selected-${version}.ts`);
        writeFileSync(selected, `
          import { release as base } from ${JSON.stringify(resolve('packages/platform/bundle/src/releases/base.ts'))};
          export const release = { ...base, createModules: () => [{
            name: 'upgrade-probe', version: '0.1.0', baseVersionRange: '^1.0.0',
            data: { owns: ['upgrade_probe'] },
            migrations: { module: 'upgrade-probe', migrations: [
              { id: '0001_first', phase: 'expand', up: 'CREATE TABLE public.upgrade_probe (id integer PRIMARY KEY, ready boolean NOT NULL); INSERT INTO public.upgrade_probe VALUES (1, false)' },
              { id: '0002_second', phase: 'expand', up: ${JSON.stringify(`DO $$ BEGIN IF NOT (SELECT ready FROM public.upgrade_probe WHERE id = 1) THEN RAISE EXCEPTION 'fixture second migration fails'; END IF; END $$; INSERT INTO public.upgrade_probe VALUES (${version === '0.2.1' ? 2 : 3}, true)`)} }
            ] }
          }] };
        `);
        const options = { bundle: true, platform: 'node' as const, target: 'node22', format: 'cjs' as const,
          tsconfig: resolve('tsconfig.json'), external: ['pg-native'],
          alias: { '@storeweave/selected-release': selected },
          define: { 'process.env.STOREWEAVE_RELEASE_VERSION': JSON.stringify(version) } };
        const emitter = join(root, `manifest-${version}.cjs`);
        await bundle({ ...options, entryPoints: ['scripts/release-manifest.ts'], outfile: emitter });
        const metadata = JSON.parse(execFileSync(process.execPath, [emitter], { encoding: 'utf8' }));
        writeFileSync(join(target!, 'release-manifest.json'), JSON.stringify(metadata.manifest));
        const info = JSON.parse(readFileSync(join(target!, 'build-info.json'), 'utf8'));
        writeFileSync(join(target!, 'build-info.json'), JSON.stringify({ ...info, manifestChecksum: metadata.checksum }));
        await bundle({ ...options, entryPoints: ['tools/cli/src/main.ts'], outfile: join(target!, 'app/cli.js'),
          define: { ...options.define, 'process.env.STOREWEAVE_BUILD_MANIFEST_SHA': JSON.stringify(metadata.checksum) } });
      }
      copyFileSync(process.execPath, join(target!, 'runtime/bin/node'));
      if (target === source) writeFileSync(join(target, 'app/api.js'), 'setInterval(() => {}, 1000);');
    }
    symlinkSync(source, join(home, 'current'));
    const config = join(root, 'config.json');
    writeFileSync(config, JSON.stringify({ version: 1, store: { id: 'paired-cli', name: 'Paired CLI' },
      database: { url: container.getConnectionUri() }, extensions: [], logging: { level: 'error' } }));
    const failureHook = join(root, 'crash-hooks.cjs');
    writeFileSync(failureHook, `
      const fs = require('node:fs');
      const exists = fs.existsSync;
      fs.existsSync = path => {
        if (process.argv[2] === 'rollback' && String(path).endsWith('/current/app/worker.js') && exists(${JSON.stringify(join(root, 'fail-start'))})) return false;
        return exists(path);
      };
      const read = fs.readFileSync;
      fs.readFileSync = (...args) => {
        const marker = ${JSON.stringify(join(root, 'swap-journal'))};
        if (process.argv[2] === 'rollback' && String(args[0]) === ${JSON.stringify(config)} && fs.existsSync(marker)) {
          const journal = read(marker, 'utf8');
          fs.unlinkSync(marker);
          fs.writeFileSync(journal, '{"untrusted-replacement":true}');
          fs.writeFileSync(${JSON.stringify(join(root, 'swap-observed'))}, 'swapped');
        }
        return read(...args);
      };
      const rename = fs.renameSync;
      fs.renameSync = (...args) => {
        const destination = String(args[1]);
        if (destination.endsWith('/upgrade.json') && fs.existsSync(${JSON.stringify(join(root, 'crash-before-journal'))})) process.kill(process.pid, 'SIGKILL');
        const phase = destination.endsWith('/journal.json') ? JSON.parse(fs.readFileSync(args[0], 'utf8')).phase : undefined;
        if (phase === 'cutover-committed' && fs.existsSync(${JSON.stringify(join(root, 'crash-after-commit'))})) process.kill(process.pid, 'SIGKILL');
        if (destination === ${JSON.stringify(join(home, 'current'))} && fs.existsSync(${JSON.stringify(join(root, 'crash-before-current'))})) process.kill(process.pid, 'SIGKILL');
        const result = rename(...args);
        if (destination === ${JSON.stringify(join(home, 'current'))} && fs.existsSync(${JSON.stringify(join(root, 'crash-after-current'))})) process.kill(process.pid, 'SIGKILL');
        if (phase === 'cutover-intent' && fs.existsSync(${JSON.stringify(join(root, 'crash-before-cutover'))})) process.kill(process.pid, 'SIGKILL');
        return result;
      };
    `);
    const env = { ...process.env, NODE_OPTIONS: `--require=${failureHook}`, PATH: `${bin}:${process.env.PATH}`, STOREWEAVE_CONFIG: config,
      STOREWEAVE_HOME: home, STOREWEAVE_DATA_DIR: join(root, 'data'), STOREWEAVE_LOG_DIR: join(root, 'logs') };
    const run = (...args: string[]) => promisify(execFile)(process.execPath, [join(source, 'app/cli.js'), ...args],
      { env, encoding: 'utf8', timeout: 90_000 });
    await run('migrate');
    const archive = join(root, 'candidate.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', root, 'storeweave-0.2.1']);
    service = spawn(process.execPath, ['-e', `
      setInterval(() => {}, 1000);
      process.on('SIGTERM', () => { require('node:fs').writeFileSync(process.argv[1], 'stopped'); process.exit(0); });
      process.stdout.write('ready');
    `, join(root, 'stopped')], { stdio: ['ignore', 'pipe', 'pipe'] });
    await once(service.stdout!, 'data');
    mkdirSync(join(root, 'data/run'), { recursive: true });
    writeFileSync(join(root, 'data/run/storeweave-api.pid'), String(service.pid));
    const workerPid = join(root, 'data/run/storeweave-worker.pid');
    writeFileSync(workerPid, '-1');
    await expect(run('upgrade', '--release', archive, '--external-writers-stopped', '--no-restart'))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Invalid PID file') });
    expect(readFileSync(join(home, 'releases/0.2.1/VERSION'), 'utf8').trim()).toBe('0.2.1');
    expect(realpathSync(join(home, 'current'))).toBe(realpathSync(source));
    rmSync(workerPid);
    writeFileSync(join(root, 'fail-dump'), '');
    await expect(run('upgrade', '--release', archive, '--external-writers-stopped', '--no-restart'))
      .rejects.toMatchObject({ stderr: expect.stringContaining('pg_dump failed') });
    expect(readdirSync(join(home, '.transitions'))).toEqual([]);
    rmSync(join(root, 'fail-dump'));
    writeFileSync(join(root, 'crash-before-journal'), '');
    const otherArchive = join(root, 'other-candidate.tar.gz');
    execFileSync('tar', ['-czf', otherArchive, '-C', root, 'storeweave-0.2.2']);
    await expect(run('upgrade', '--release', otherArchive, '--external-writers-stopped', '--no-restart')).rejects.toMatchObject({ signal: 'SIGKILL' });
    await expect(run('upgrade', '--release', archive, '--external-writers-stopped', '--no-restart')).rejects.toMatchObject({ signal: 'SIGKILL' });
    rmSync(join(root, 'crash-before-journal'));
    const operationRoot = join(home, '.transitions');
    const orphan = readdirSync(operationRoot).map(id => join(operationRoot, id)).find(path => {
      try { return JSON.parse(readFileSync(join(path, 'snapshot.json'), 'utf8')).candidate.version === '0.2.1'; } catch { return false; }
    })!;
    const orphanChecksum = catalogDigest(JSON.parse(readFileSync(join(orphan, 'snapshot.json'), 'utf8')));
    const beforeRetry = await container.exec(['psql', '-U', 'fixture', '-d', 'paired_cli', '-At', '-c', 'SELECT count(*) FROM public.platform_release_history']);
    expect(beforeRetry.stdout.trim()).toBe('1');
    const changedSource = await container.exec(['psql', '-U', 'fixture', '-d', 'paired_cli', '-At', '-c',
      "UPDATE public.platform_migrations SET applied_at = applied_at + interval '1 microsecond'"]);
    expect(changedSource.exitCode, changedSource.output).toBe(0);
    const beforeOrphanAttempt = readdirSync(operationRoot).sort();
    await expect(run('upgrade', '--snapshot', orphan, '--checksum', orphanChecksum, '--external-writers-stopped', '--no-restart'))
      .rejects.toMatchObject({ stderr: expect.stringContaining('history mismatch') });
    expect(readdirSync(operationRoot).sort()).toEqual(beforeOrphanAttempt);
    const restoredSource = await container.exec(['psql', '-U', 'fixture', '-d', 'paired_cli', '-At', '-c',
      "UPDATE public.platform_migrations SET applied_at = applied_at - interval '1 microsecond'"]);
    expect(restoredSource.exitCode, restoredSource.output).toBe(0);
    await expect(run('upgrade', '--snapshot', orphan, '--checksum', orphanChecksum, '--external-writers-stopped', '--no-restart'))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Release CLI failed') });
    expect(realpathSync(join(home, 'current'))).toBe(realpathSync(source));
    const journalFile = readdirSync(operationRoot).map(id => join(operationRoot, id, 'upgrade.json')).find(file => {
      try { return JSON.parse(readFileSync(file, 'utf8')).kind === 'upgrade'; } catch { return false; }
    })!;
    const { journal, snapshot } = await readUpgradeJournal(journalFile, operationRoot);
    expect(journal.phase).toBe('migrating');
    const partial = await container.exec(['psql', '-U', 'fixture', '-d', 'paired_cli', '-At', '-c',
      "SELECT id FROM public.platform_migrations WHERE id LIKE 'upgrade-probe/%' ORDER BY id; SELECT id FROM public.upgrade_probe ORDER BY id"]);
    expect(partial.exitCode, partial.output).toBe(0);
    expect(partial.stdout.trim().split('\n')).toEqual(['upgrade-probe/0001_first', '1']);
    const otherPair = readdirSync(operationRoot).map(id => join(operationRoot, id)).find(path => {
      try { return JSON.parse(readFileSync(join(path, 'snapshot.json'), 'utf8')).candidate.version === '0.2.2'; } catch { return false; }
    })!;
    const otherChecksum = catalogDigest(JSON.parse(readFileSync(join(otherPair, 'snapshot.json'), 'utf8')));
    const beforeDifferentCandidate = readdirSync(operationRoot).sort();
    await expect(run('upgrade', '--snapshot', otherPair, '--checksum', otherChecksum, '--external-writers-stopped', '--no-restart'))
      .rejects.toMatchObject({ stderr: expect.stringContaining('history mismatch') });
    expect(readdirSync(operationRoot).sort()).toEqual(beforeDifferentCandidate);
    expect(realpathSync(join(home, 'current'))).toBe(realpathSync(source));
    // Remove the fixture's SQL failure condition without altering migration bytes or history.
    const allowRetry = await container.exec(['psql', '-U', 'fixture', '-d', 'paired_cli', '-c',
      'UPDATE public.upgrade_probe SET ready = true WHERE id = 1']);
    expect(allowRetry.exitCode, allowRetry.output).toBe(0);
    expect(snapshot.manifest.source.version).toBe('0.2.0');
    expect(snapshot.manifest.candidate.version).toBe('0.2.1');
    writeFileSync(join(root, 'crash-before-current'), '');
    await expect(run('upgrade', '--resume', journalFile, '--external-writers-stopped', '--no-restart'))
      .rejects.toMatchObject({ signal: 'SIGKILL' });
    rmSync(join(root, 'crash-before-current'));
    expect(realpathSync(join(home, 'current'))).toBe(realpathSync(source));
    expect((await readUpgradeJournal(journalFile, operationRoot)).journal.phase).toBe('migrated');
    writeFileSync(join(root, 'crash-after-current'), '');
    await expect(run('upgrade', '--resume', journalFile, '--external-writers-stopped', '--no-restart'))
      .rejects.toMatchObject({ signal: 'SIGKILL' });
    rmSync(join(root, 'crash-after-current'));
    expect(readlinkSync(join(home, 'current'))).toBe(join(home, 'releases', '0.2.1'));
    expect((await readUpgradeJournal(journalFile, operationRoot)).journal.phase).toBe('migrated');
    await run('upgrade', '--resume', journalFile, '--external-writers-stopped', '--no-restart');
    expect(readlinkSync(join(home, 'current'))).toBe(join(home, 'releases', '0.2.1'));
    expect((await readUpgradeJournal(journalFile, operationRoot)).journal.phase).toBe('activated');
    await run('upgrade', '--resume', journalFile, '--external-writers-stopped', '--no-restart');
    const history = await container.exec(['psql', '-U', 'fixture', '-d', 'paired_cli', '-At', '-c', 'SELECT count(*) FROM public.platform_release_history']);
    expect(history.stdout.trim()).toBe('2');
    const completed = await container.exec(['psql', '-U', 'fixture', '-d', 'paired_cli', '-At', '-c',
      'SELECT id FROM public.upgrade_probe ORDER BY id']);
    expect(completed.stdout.trim().split('\n')).toEqual(['1', '2']);
    writeFileSync(join(root, 'crash-before-cutover'), '');
    await expect(run('rollback', '--snapshot', snapshot.directory, '--checksum', journal.snapshot.checksum,
      '--yes', '--external-writers-stopped', '--no-restart')).rejects.toMatchObject({ signal: 'SIGKILL' });
    rmSync(join(root, 'crash-before-cutover'));
    const restoreFile = readdirSync(operationRoot).map(id => join(operationRoot, id, 'journal.json')).find(file => {
      try { return JSON.parse(readFileSync(file, 'utf8')).phase === 'cutover-intent'; } catch { return false; }
    })!;
    const restore = JSON.parse(readFileSync(restoreFile, 'utf8'));
    const outsideHome = join(root, 'outside', restore.id);
    mkdirSync(outsideHome, { recursive: true, mode: 0o700 });
    const outsideJournal = join(outsideHome, 'journal.json');
    writeFileSync(outsideJournal, JSON.stringify(restore), { mode: 0o600 });
    await expect(run('rollback', '--resume', outsideJournal, '--yes', '--external-writers-stopped', '--no-restart'))
      .rejects.toMatchObject({ stderr: expect.stringContaining('outside the locked transition root') });

    const liveOid = async () => (await container.exec(['psql', '-U', 'fixture', '-d', 'postgres', '-At', '-c',
      "SELECT oid::text FROM pg_catalog.pg_database WHERE datname = 'paired_cli'"])).stdout.trim();
    expect(await liveOid()).toBe(restore.live.oid);
    writeFileSync(join(root, 'crash-after-commit'), '');
    await expect(run('rollback', '--resume', restoreFile, '--yes', '--external-writers-stopped', '--no-restart'))
      .rejects.toMatchObject({ signal: 'SIGKILL' });
    rmSync(join(root, 'crash-after-commit'));
    expect(await liveOid()).toBe(restore.scratch.oid);
    expect(JSON.parse(readFileSync(restoreFile, 'utf8')).phase).toBe('cutover-intent');
    expect(readlinkSync(join(home, 'current'))).toBe(join(home, 'releases', '0.2.1'));
    writeFileSync(join(root, 'crash-before-current'), '');
    await expect(run('rollback', '--resume', restoreFile, '--yes', '--external-writers-stopped', '--no-restart'))
      .rejects.toMatchObject({ signal: 'SIGKILL' });
    rmSync(join(root, 'crash-before-current'));
    expect(JSON.parse(readFileSync(restoreFile, 'utf8')).phase).toBe('cutover-committed');
    expect(readlinkSync(join(home, 'current'))).toBe(join(home, 'releases', '0.2.1'));
    writeFileSync(join(root, 'swap-journal'), restoreFile);
    writeFileSync(join(root, 'fail-start'), '');
    await expect(run('rollback', '--resume', restoreFile, '--yes', '--external-writers-stopped'))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Missing application entrypoint') });
    rmSync(join(root, 'fail-start'));
    expect(readdirSync(join(root, 'data/run')).filter(name => name.endsWith('.pid'))).toEqual([]);
    await run('rollback', '--resume', restoreFile, '--yes', '--external-writers-stopped', '--no-restart');
    expect(readFileSync(join(root, 'swap-observed'), 'utf8')).toBe('swapped');
    expect(JSON.parse(readFileSync(restoreFile, 'utf8')).phase).toBe('cutover-committed');
    expect(realpathSync(join(home, 'current'))).toBe(realpathSync(source));
    const restored = await container.exec(['psql', '-U', 'fixture', '-d', 'paired_cli', '-At', '-c', 'SELECT release_version FROM public.platform_release_history']);
    expect(restored.stdout.trim()).toBe('0.2.0');
    const restoredSchema = await container.exec(['psql', '-U', 'fixture', '-d', 'paired_cli', '-At', '-c',
      "SELECT to_regclass('public.upgrade_probe') IS NULL"]);
    expect(restoredSchema.stdout.trim()).toBe('t');
  } finally {
    if (service && service.exitCode === null && service.signalCode === null) service.kill('SIGKILL');
    await container.stop(); rmSync(root, { recursive: true, force: true }); }
});
