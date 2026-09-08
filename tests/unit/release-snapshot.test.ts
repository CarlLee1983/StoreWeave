import { runReleaseCli } from '../../tools/cli/src/run-release-cli';
import { resumeRestoreCutover } from '../../tools/cli/src/resume-restore';
import { createUpgradeJournal, readUpgradeJournal, writeUpgradeJournal } from '../../tools/cli/src/upgrade-journal';
import { verifySourceRuntime } from '../../tools/cli/src/verify-source-runtime';
import { randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { catalogDigest, type ReleaseSnapshot } from '@storeweave/db';
import { readRestoreJournal } from '../../tools/cli/src/restore-journal';
import { readPairedSnapshot } from '../../tools/cli/src/read-release-snapshot';
import { writePgBackup } from '../../tools/cli/src/pg-tool';
import { createPairedSnapshot } from '../../tools/cli/src/release-snapshot';
import { validateLegacyB01Directory, validateReleaseDirectory } from '../../tools/cli/src/release-validation';
import { writeNativeRelease } from './fixtures/native-release';

// 這支測試會實際 spawn release runtime 的 node 子程序，預設 5s 不足以涵蓋機器負載。
vi.setConfig({ testTimeout: 30_000 });

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, cpSync: vi.fn(actual.cpSync) };
});

vi.mock('../../tools/cli/src/pg-tool', async importOriginal => ({ ...await importOriginal<typeof import('../../tools/cli/src/pg-tool')>(), writePgBackup: vi.fn(async (_url: string, file: string) => {
  writeFileSync(file, 'PGDMPfixture', { mode: 0o600 });
}) }));
let root: string;
let options: Parameters<typeof createPairedSnapshot>[0];
let evidence: ReleaseSnapshot;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'storeweave-paired-snapshot-'));
  options = { databaseUrl: 'postgres://user:private-secret@host/db', sourceDirectory: join(root, 'source'),
    candidateDirectory: join(root, 'candidate'), snapshotDirectory: join(root, 'snapshots') };
  writeNativeRelease(options.sourceDirectory);
  writeNativeRelease(options.candidateDirectory, 'commerce', '1.0.1');
  evidence = { snapshotId: 'exported-snapshot', database: { name: 'db', oid: '123', systemIdentifier: '456', serverVersion: '17',
    properties: { owner: 'user', encoding: 'UTF8', localeProvider: 'c', locale: null, icuRules: null, collate: 'C', ctype: 'C',
      tablespace: 'pg_default', connectionLimit: -1, comment: null, acl: [], settings: [] } },
    release: { sequence: '1', checksum: catalogDigest('effective'), releaseId: 'commerce', releaseVersion: '1.0.0',
      buildManifestChecksum: validateReleaseDirectory(options.sourceDirectory).manifestChecksum },
    migrationsChecksum: catalogDigest('migrations'), historyChecksum: catalogDigest('history'), historySequence: { lastValue: '1', isCalled: true } };
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it('publishes the bound dump and descriptor only after the capture boundary resolves', async () => {
  const result = await createPairedSnapshot(options, async dump => {
    const staged = await dump(evidence);
    expect(readdirSync(options.snapshotDirectory).every(name => name.startsWith('.snapshot-'))).toBe(true);
    return staged;
  });
  expect(readdirSync(options.snapshotDirectory)).toEqual([result.manifest.id]);
  const stored = readFileSync(join(result.directory, 'snapshot.json'), 'utf8');
  expect(JSON.parse(stored)).toEqual(result.manifest);
  expect(stored).not.toContain('private-secret');
  expect(stored).not.toContain('exported-snapshot');
  expect(result.manifest.evidence.historySequence).toEqual(evidence.historySequence);
  expect(result.manifest.dump.checksum).toMatch(/^[a-f0-9]{64}$/);
  expect(statSync(join(result.directory, 'snapshot.json')).mode & 0o777).toBe(0o600);
  expect(statSync(join(result.directory, 'database.dump')).mode & 0o777).toBe(0o600);
});

it.each(['commit', 'source', 'artifact'])('does not publish when %s validation fails', async failure => {
  await expect(createPairedSnapshot(options, async dump => {
    if (failure === 'source') evidence.release.releaseVersion = 'other';
    if (failure === 'artifact') writeFileSync(join(options.candidateDirectory, 'app', 'api.js'), 'changed');
    const staged = await dump(evidence);
    if (failure === 'commit') throw new Error('commit failed');
    return staged;
  })).rejects.toThrow();
  expect(readdirSync(options.snapshotDirectory)).toEqual([]);
});


it('requires an explicit endpoint rather than binding an environment-dependent host', async () => {
  options.databaseUrl = 'postgres:///db';
  const capture = vi.fn();
  await expect(createPairedSnapshot(options, capture)).rejects.toThrow('explicit database host');
  expect(capture).not.toHaveBeenCalled();
});

it('rejects a capture from a different database name', async () => {
  evidence.database.name = 'different';
  await expect(createPairedSnapshot(options, dump => dump(evidence))).rejects.toThrow('database name');
  expect(readdirSync(options.snapshotDirectory)).toEqual([]);
});

it('pins the inherited port in both the native connection and endpoint fingerprint', async () => {
  vi.stubEnv('PGPORT', '5544');
  const first = await createPairedSnapshot(options, dump => dump(evidence));
  expect(vi.mocked(writePgBackup).mock.calls.at(-1)?.[0]).toBe('postgres://user:private-secret@host:5544/db');
  vi.stubEnv('PGPORT', '5545');
  const second = await createPairedSnapshot(options, dump => dump(evidence));
  expect(second.manifest.endpointChecksum).not.toBe(first.manifest.endpointChecksum);
});


it('reads a journal-bound pair and refuses descriptor, dump and artifact tampering', async () => {
  const paired = await createPairedSnapshot(options, dump => dump(evidence));
  expect((await readPairedSnapshot(paired.directory, paired.manifestChecksum)).manifest).toEqual(paired.manifest);
  await expect(readPairedSnapshot(paired.directory, catalogDigest('wrong'))).rejects.toThrow('descriptor checksum');
  const dump = join(paired.directory, 'database.dump');
  writeFileSync(dump, 'PGDMPchanged');
  await expect(readPairedSnapshot(paired.directory, paired.manifestChecksum)).rejects.toThrow('dump checksum');
  writeFileSync(dump, 'PGDMPfixture');
  chmodSync(dump, 0o644);
  await expect(readPairedSnapshot(paired.directory, paired.manifestChecksum)).rejects.toThrow('private regular');
  chmodSync(dump, 0o600);
  writeFileSync(join(options.sourceDirectory, 'app', 'api.js'), 'changed');
  await expect(readPairedSnapshot(paired.directory, paired.manifestChecksum)).rejects.toThrow('artifact changed');
});


it.each(['schema', 'dump-path', 'directory'])('rejects malformed %s even with a matching descriptor checksum', async kind => {
  const paired = await createPairedSnapshot(options, dump => dump(evidence));
  const file = join(paired.directory, 'snapshot.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (kind === 'schema') raw.schemaVersion = 2;
  if (kind === 'dump-path') raw.dump.file = '../other.dump';
  if (kind === 'directory') raw.source.directory = 'relative';
  writeFileSync(file, JSON.stringify(raw));
  await expect(readPairedSnapshot(paired.directory, catalogDigest(raw))).rejects.toThrow();
});

it.each(['symlink', 'oversized'])('rejects %s metadata before parsing it', async kind => {
  const paired = await createPairedSnapshot(options, dump => dump(evidence));
  const file = join(paired.directory, 'snapshot.json');
  if (kind === 'symlink') {
    unlinkSync(file);
    symlinkSync(join(root, 'missing'), file);
  } else truncateSync(file, 1024 * 1024 + 1);
  await expect(readPairedSnapshot(paired.directory, paired.manifestChecksum)).rejects.toThrow();
});


it.each(['sourceDirectory', 'candidateDirectory'] as const)('refuses changes to %s after the dump callback completes', async key => {
  await expect(createPairedSnapshot(options, async dump => {
    const staged = await dump(evidence);
    writeFileSync(join(options[key], 'app', 'api.js'), 'changed after dump');
    return staged;
  })).rejects.toThrow('before snapshot publication');
  expect(readdirSync(options.snapshotDirectory)).toEqual([]);
});


it('binds a restore journal to its private snapshot and rejects forged identity or progress', async () => {
  const pair = await createPairedSnapshot(options, dump => dump(evidence));
  const id = randomUUID();
  const home = join(root, id);
  mkdirSync(home, { mode: 0o700 });
  const file = join(home, 'journal.json');
  const entry = { schemaVersion: 1, kind: 'restore', id, phase: 'restored',
    snapshot: { directory: pair.directory, checksum: pair.manifestChecksum }, systemIdentifier: evidence.database.systemIdentifier,
    live: { name: evidence.database.name, oid: evidence.database.oid },
    scratch: { name: `storeweave_restore_${id.replaceAll('-', '')}`, oid: '789' }, quarantineName: `storeweave_retained_${id.replaceAll('-', '')}` };
  const write = (value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  write(entry);
  expect((await readRestoreJournal(file, root)).journal).toEqual(entry);
  const otherRoot = join(root, 'other-operation-root');
  mkdirSync(otherRoot, { mode: 0o700 });
  await expect(readRestoreJournal(file, otherRoot)).rejects.toThrow('outside the locked transition root');
  chmodSync(home, 0o755);
  await expect(readRestoreJournal(file, root)).rejects.toThrow('owned and 0700');
  chmodSync(home, 0o700);
  write({ ...entry, phase: 'cutover-intent' });
  const bound = await readRestoreJournal(file, root);
  const beforeEndpointFailure = readFileSync(file, 'utf8');
  await expect(resumeRestoreCutover(bound, 'postgres://user:secret@127.0.0.1:1/postgres', 'unused-config'))
    .rejects.toThrow('Snapshot endpoint mismatch');
  expect(readFileSync(file, 'utf8')).toBe(beforeEndpointFailure);
  for (const scratchOid of [null, '789']) {
    const failed = { ...entry, phase: 'failed', scratch: { ...entry.scratch, oid: scratchOid } };
    write(failed);
    expect((await readRestoreJournal(file, root)).journal).toEqual(failed);
  }
  for (const changed of [
    { ...entry, id: randomUUID() }, { ...entry, phase: 'complete' }, { ...entry, phase: 'planned' },
    { ...entry, scratch: { ...entry.scratch, oid: null } },
    { ...entry, live: { ...entry.live, oid: '999' } }, { ...entry, systemIdentifier: '999' },
    { ...entry, snapshot: { ...entry.snapshot, checksum: catalogDigest('wrong') } },
    { ...entry, quarantineName: 'unrelated' }, { ...entry, extra: true },
  ]) {
    write(changed);
    await expect(readRestoreJournal(file, root)).rejects.toThrow();
  }
});


it.each(['runtime/bin/node', 'app/cli.js'])('rejects replacement of %s between pair validation and private execution without executing it', async entry => {
  copyFileSync(process.execPath, join(options.sourceDirectory, 'runtime/bin/node'));
  const pair = await createPairedSnapshot(options, dump => dump(evidence));
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ database: { url: options.databaseUrl } }));
  const sentinel = join(root, 'unbound-executed');
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(cpSync).mockImplementationOnce((source, target, settings) => {
    writeFileSync(join(String(source), entry), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`);
    actual.cpSync(source, target, settings);
  });
  await expect(verifySourceRuntime(pair.directory, pair.manifestChecksum, config, options.databaseUrl)).rejects.toThrow('changed before execution');
  expect(existsSync(sentinel)).toBe(false);
});


it('durably binds upgrade progress to the immutable pair and refuses forged identity or phase', async () => {
  const pair = await createPairedSnapshot(options, dump => dump(evidence));
  const file = await createUpgradeJournal(root, pair.directory, pair.manifestChecksum);
  const initial = await readUpgradeJournal(file, root);
  expect(initial.journal.phase).toBe('prepared');
  expect(initial.snapshot.manifestChecksum).toBe(pair.manifestChecksum);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  for (const phase of ['migrating', 'migrated', 'activated'] as const) {
    writeUpgradeJournal(file, { ...initial.journal, phase }, root);
    expect((await readUpgradeJournal(file, root)).journal.phase).toBe(phase);
  }
  for (const changed of [{ ...initial.journal, id: randomUUID() }, { ...initial.journal, phase: 'unknown' },
    { ...initial.journal, snapshot: { ...initial.journal.snapshot, checksum: catalogDigest('wrong') } }]) {
    writeFileSync(file, JSON.stringify(changed));
    await expect(readUpgradeJournal(file, root)).rejects.toThrow();
  }
  expect(readFileSync(join(pair.directory, 'snapshot.json'), 'utf8')).toBe(`${JSON.stringify(pair.manifest)}\n`);
});

it.each(['runtime/bin/node', 'app/cli.js'])('executes the private copy when original %s changes after copying, then rejects the final reread', async entry => {
  copyFileSync(process.execPath, join(options.sourceDirectory, 'runtime/bin/node'));
  const clean = join(root, 'bound-executed'), sentinel = join(root, 'unbound-executed');
  writeFileSync(join(options.sourceDirectory, 'app/cli.js'), `require('node:fs').writeFileSync(${JSON.stringify(clean)}, 'executed'); console.log(JSON.stringify({ releaseCurrent: true, pending: [], applied: [] }));`);
  const pair = await createPairedSnapshot(options, dump => dump(evidence));
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ database: { url: options.databaseUrl } }));
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(cpSync).mockImplementationOnce((source, target, settings) => {
    actual.cpSync(source, target, settings);
    writeFileSync(join(String(source), entry), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`);
  });
  await expect(verifySourceRuntime(pair.directory, pair.manifestChecksum, config, options.databaseUrl)).rejects.toThrow('Snapshot release artifact changed');
  expect(existsSync(clean)).toBe(true);
  expect(existsSync(sentinel)).toBe(false);
});

it('runs only B01 status from a private validated copy without modern JSON flags', () => {
  const source = options.sourceDirectory;
  for (const file of ['RELEASE', 'release-manifest.json', 'scripts/validate-release.js', 'app/seed.js']) rmSync(join(source, file));
  writeFileSync(join(source, 'VERSION'), '0.1.0');
  writeFileSync(join(source, 'build-info.json'), JSON.stringify({ version: '0.1.0', builtOnNode: 'v22.17.1', entries: ['/dist/app/api.js', '/dist/app/worker.js', '/dist/app/cli.js'] }));
  copyFileSync(process.execPath, join(source, 'runtime/bin/node'));
  writeFileSync(join(source, 'app/cli.js'), `
    const assert = require('node:assert/strict');
    assert.deepEqual(process.argv.slice(2), ['migrate', '--status']);
    assert.ok(__filename.includes('storeweave-release-cli-'));
    const config = JSON.parse(require('node:fs').readFileSync(process.env.COMMERCE_CONFIG, 'utf8'));
    assert.equal(config.database.autoMigrate, false);
    assert.ok(new URL(process.env.STOREWEAVE_VERIFY_DATABASE_URL).searchParams.get('options').endsWith('-c search_path=public'));
    process.stdout.write('已套用\\n待套用\\n（無）');
  `);
  const expected = validateLegacyB01Directory(source), config = join(root, 'legacy-config.json');
  writeFileSync(config, JSON.stringify({ database: { url: options.databaseUrl, autoMigrate: true } }));
  expect(runReleaseCli(expected, config, options.databaseUrl, 'status')).toBe('已套用\n待套用\n（無）');
  expect(() => runReleaseCli(expected, config, options.databaseUrl, 'migrate')).toThrow('Legacy recovery CLI only supports status');
  writeFileSync(join(source, 'app/cli.js'), `process.stdout.write('已套用\\n待套用\\n  platform/0001 (expand)');`);
  expect(() => runReleaseCli(validateLegacyB01Directory(source), config, options.databaseUrl, 'status')).toThrow('pending migrations or invalid status');
});
