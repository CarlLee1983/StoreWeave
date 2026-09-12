import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Client } from 'pg';
import semver from 'semver';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterEach, expect, it, vi } from 'vitest';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { release } from '@storeweave/selected-release';
import { catalogDigest, sqlMigration } from '@storeweave/db';
import { commerceConfigSchema, type CommerceConfig } from '@storeweave/config';
import { defineModule, Worker } from '@storeweave/kernel';
import type { ReleaseDefinition } from '../../packages/platform/bundle/src/release';
import { ADMIN_ACTOR } from './helpers';
import { runFullRestore } from '../../tools/cli/src/full-restore';
import { discardFullRecovery, listFullRecoveries } from '../../tools/cli/src/full-recovery-discard';
import { readFullRecoveryJournal } from '../../tools/cli/src/full-recovery-journal';
import { writePgBackup } from '../../tools/cli/src/pg-tool';
import { captureStorageBackup, fullBackupSchema, writeStorageBackupCatalog, writeStorageBackupManifest } from '../../tools/cli/src/storage-backup';

let root: string | undefined;
let container: StartedPostgreSqlContainer | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await container?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

it('recovers a complete bundle into a clean configured database and preserves ready-object bytes', async () => {
  root = mkdtempSync(join(tmpdir(), 'storeweave-full-restore-'));
  const sourceStorage = join(root, 'source-storage'), targetStorage = join(root, 'target-storage');
  const bundle = join(root, 'bundle'), operations = join(root, 'operations'), bin = join(root, 'bin');
  for (const directory of [bundle, operations, bin]) mkdirSync(directory, { mode: 0o700 });
  container = await new PostgreSqlContainer('postgres:17-alpine').withDatabase('source_live')
    .withUsername('commerce').withPassword('full-restore-password').start();
  installPgWrappers(bin, root);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  const sourceUrl = new URL(container.getConnectionUri());
  sourceUrl.password = 'full-restore-password';
  const config = join(root, 'source.json');
  vi.stubEnv('SW_SIGNING_KEY_TEST', Buffer.alloc(32, 11).toString('base64url'));
  writeFileSync(config, JSON.stringify(configuration(sourceUrl.toString(), sourceStorage)), { mode: 0o600 });
  const runtime = (await bootstrapRelease(release, { configPath: config, loggerName: 'full-restore-source', logDestination: 'stderr' })).runtime;
  try {
    await runtime.migrate();
    await runtime.activateRelease('apply');
    const payload = Buffer.from('full recovery has the exact media bytes');
    const saved = await runtime.storage.forNamespace('platform-storage').upload({ stream: Readable.from([payload]),
      originalName: 'full-recovery.txt', contentType: 'text/plain', visibility: 'private' });
    const captured = await runtime.withReleaseSnapshot(async (evidence, client) => {
      const dump = join(bundle, 'database.dump');
      await writePgBackup(sourceUrl.toString(), dump, evidence.snapshotId);
      const storage = await captureStorageBackup(runtime, client, bundle);
      const digest = await digestFile(dump);
      const manifest = fullBackupSchema.parse({ schemaVersion: 1, kind: 'storeweave-full-backup', createdAt: new Date().toISOString(),
        release: { id: evidence.release.releaseId, version: evidence.release.releaseVersion, buildManifestChecksum: evidence.release.buildManifestChecksum },
        endpointChecksum: catalogDigest({ host: sourceUrl.hostname, port: sourceUrl.port || '5432', database: evidence.database.name }),
        evidence: (() => { const { snapshotId: _discarded, ...savedEvidence } = evidence; return savedEvidence; })(),
        database: { file: 'database.dump', byteSize: digest.byteSize, sha256: digest.sha256 }, storage: await writeStorageBackupCatalog(bundle, storage),
      });
      writeStorageBackupManifest(bundle, manifest);
      return { storage, manifest };
    });
    const targetUrl = new URL(sourceUrl);
    targetUrl.pathname = '/recovered_live';
    const target = configuration(targetUrl.toString(), targetStorage);
    const targetConfig = join(root, 'target.json');
    writeFileSync(targetConfig, JSON.stringify(target), { mode: 0o600 });
    const maintenance = new URL(sourceUrl);
    maintenance.pathname = '/postgres';
    const recovered = await runFullRestore({ bundleDirectory: bundle, operationRoot: operations, maintenanceUrl: maintenance.toString(),
      configFile: targetConfig, config: target });
    expect(recovered.quarantineName).toBeNull();
    expect(recovered.objects).toBe(1);
    // The replay published the object once. A resume must not republish it:
    // re-reading every byte is what makes a large recovery's RTO collapse.
    expect(recovered.restoredObjects).toBe(1);
    await expect(runFullRestore({ bundleDirectory: bundle, operationRoot: operations, maintenanceUrl: maintenance.toString(),
      configFile: targetConfig, config: target, resumeJournal: recovered.journalFile })).resolves.toMatchObject({
      journalFile: recovered.journalFile, objects: 1, restoredObjects: 1,
    });
    // A verified recovery is the live deployment; discarding it would drop the
    // database the operator just recovered.
    await expect(discardFullRecovery({ journalFile: recovered.journalFile, operationRoot: operations,
      maintenanceUrl: maintenance.toString(), config: target })).rejects.toThrow(/not discardable/);
    const restored = (await bootstrapRelease(release, { configPath: targetConfig, loggerName: 'full-restore-target', logDestination: 'stderr' })).runtime;
    try {
      await restored.activateRelease('require-current');
      const opened = await restored.storage.forNamespace('platform-storage').open(saved.id);
      const bytes = await readBuffer(opened.content.stream);
      expect(bytes).toEqual(payload);
      expect(opened.object).toMatchObject({ storageKey: saved.storageKey, sha256: createHash('sha256').update(payload).digest('hex') });
    } finally { await restored.close(); }
  } finally { await runtime.close(); }
});

it('upgrades DB, pending work and private media together, rejects mixed releases, and restores the source recovery point', async () => {
  root = mkdtempSync(join(tmpdir(), 'storeweave-b17-release-drill-'));
  const storageRoot = join(root, 'storage'), bundle = join(root, 'bundle');
  const operations = join(root, 'operations'), bin = join(root, 'bin');
  for (const directory of [bundle, operations, bin]) mkdirSync(directory, { mode: 0o700 });
  container = await new PostgreSqlContainer('postgres:17-alpine').withDatabase('b17_live')
    .withUsername('commerce').withPassword('b17-release-password').start();
  installPgWrappers(bin, root);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  vi.stubEnv('SW_SIGNING_KEY_TEST', Buffer.alloc(32, 17).toString('base64url'));
  const liveUrl = new URL(container.getConnectionUri());
  liveUrl.password = 'b17-release-password';
  const config = configuration(liveUrl.toString(), storageRoot);
  const configFile = join(root, 'commerce.json');
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const maintenance = new URL(liveUrl);
  maintenance.pathname = '/postgres';

  const source = (await bootstrapRelease(release, {
    configPath: configFile, loggerName: 'b17-release-source', logDestination: 'stderr',
  })).runtime;
  let media!: Awaited<ReturnType<typeof source.media.upload>>;
  let sourceMedia!: NonNullable<Awaited<ReturnType<typeof source.media.get>>>;
  let sourceMediaDigests!: { original: string; preview: string };
  let sourceMediaStorageKeys!: [string, string];
  let sourceJob!: {
    id: string; occurrence_id: string; type: string; payload: unknown; payload_version: number; status: string;
    attempts: number; max_attempts: number; dedupe_key: string | null; run_at: Date;
  };
  const siteSentinel = { tagline: 'B17 source release', footerNote: 'restored with the source bundle' };
  try {
    await source.migrate();
    await source.commands.execute('platform.site.updateSettings', siteSentinel, {
      actor: ADMIN_ACTOR, idempotencyKey: randomUUID(),
    });
    media = await source.media.upload({
      stream: Readable.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')),
      originalName: 'b17-release-proof.png', contentType: 'image/png', ownerActorId: 'user:b17-release',
    });
    await source.media.process({ assetId: media.id, generation: media.generation }, { signal: new AbortController().signal });
    const loadedMedia = await source.media.get(media.id);
    if (!loadedMedia) throw new Error('Processed media disappeared before the source snapshot');
    sourceMedia = loadedMedia;
    expect(sourceMedia).toMatchObject({ status: 'ready', originalObjectId: media.originalObjectId,
      previewObjectId: expect.any(String) });
    const [sourceOriginal, sourcePreview] = await Promise.all([
      source.storage.forNamespace('platform-media').open(sourceMedia.originalObjectId),
      source.storage.forNamespace('platform-media').open(sourceMedia.previewObjectId!),
    ]);
    sourceMediaDigests = {
      original: createHash('sha256').update(await readBuffer(sourceOriginal.content.stream)).digest('hex'),
      preview: createHash('sha256').update(await readBuffer(sourcePreview.content.stream)).digest('hex'),
    };
    sourceMediaStorageKeys = [sourceOriginal.object.storageKey, sourcePreview.object.storageKey];
    sourceJob = (await source.database.pool.query<typeof sourceJob>(`SELECT id, occurrence_id, type, payload, payload_version, status,
      attempts, max_attempts, dedupe_key, run_at FROM platform_jobs WHERE dedupe_key = $1`, [`media:process:${media.id}`])).rows[0]!;
    expect(sourceJob).toMatchObject({ type: 'platform.media.process', status: 'pending', attempts: 0,
      payload_version: 1, payload: { assetId: media.id, generation: media.generation } });

    await source.withReleaseSnapshot(async (evidence, client) => {
      const dump = join(bundle, 'database.dump');
      await writePgBackup(liveUrl.toString(), dump, evidence.snapshotId);
      const storage = await captureStorageBackup(source, client, bundle);
      const digest = await digestFile(dump);
      const manifest = fullBackupSchema.parse({ schemaVersion: 1, kind: 'storeweave-full-backup', createdAt: new Date().toISOString(),
        release: { id: evidence.release.releaseId, version: evidence.release.releaseVersion, buildManifestChecksum: evidence.release.buildManifestChecksum },
        endpointChecksum: catalogDigest({ host: liveUrl.hostname, port: liveUrl.port || '5432', database: evidence.database.name }),
        evidence: (() => { const { snapshotId: _discarded, ...savedEvidence } = evidence; return savedEvidence; })(),
        database: { file: 'database.dump', byteSize: digest.byteSize, sha256: digest.sha256 }, storage: await writeStorageBackupCatalog(bundle, storage),
      });
      writeStorageBackupManifest(bundle, manifest);
    });
  } finally { await source.close(); }

  const probeMigration = {
    module: 'b17-upgrade-probe',
    migrations: [sqlMigration('0001_candidate_marker', 'migrate', `
      CREATE TABLE public.b17_upgrade_probe (id integer PRIMARY KEY, marker text NOT NULL);
      INSERT INTO public.b17_upgrade_probe VALUES (1, 'candidate-only');
    `)],
  };
  const candidate: ReleaseDefinition<CommerceConfig> = {
    ...release,
    version: semver.inc(release.version, 'patch')!,
    createModules: context => [...release.createModules(context), defineModule({
      name: 'b17-upgrade-probe', version: '0.1.0', baseVersionRange: '^1.0.0',
      data: { owns: ['b17_upgrade_probe'] }, migrations: probeMigration,
    })],
  };

  const prematureCandidate = (await bootstrapRelease(candidate, {
    configPath: configFile, loggerName: 'b17-premature-candidate', logDestination: 'stderr',
  })).runtime;
  await expect(prematureCandidate.activateRelease('require-current'))
    .rejects.toThrow('Release transition requires the migrate command while writers are stopped');

  const target = (await bootstrapRelease(candidate, {
    configPath: configFile, loggerName: 'b17-release-target', logDestination: 'stderr',
  })).runtime;
  try {
    await expect(target.migrate()).resolves.toContain('b17-upgrade-probe/0001_candidate_marker');
    const worker = new Worker(target, { workerId: 'b17-target-worker', concurrency: 1 });
    await expect(worker.runJobs()).resolves.toEqual({ processed: 1, failed: 0 });
    expect((await target.database.pool.query('SELECT status FROM platform_jobs WHERE id = $1', [sourceJob.id])).rows)
      .toEqual([{ status: 'completed' }]);
    expect((await target.database.pool.query('SELECT marker FROM b17_upgrade_probe')).rows)
      .toEqual([{ marker: 'candidate-only' }]);
    expect((await target.database.pool.query('SELECT tagline, footer_note FROM platform_site_settings')).rows)
      .toEqual([{ tagline: siteSentinel.tagline, footer_note: siteSentinel.footerNote }]);
    expect(await target.media.get(media.id)).toEqual(sourceMedia);
    const [targetOriginal, targetPreview] = await Promise.all([
      target.storage.forNamespace('platform-media').open(sourceMedia.originalObjectId),
      target.storage.forNamespace('platform-media').open(sourceMedia.previewObjectId!),
    ]);
    expect({
      original: createHash('sha256').update(await readBuffer(targetOriginal.content.stream)).digest('hex'),
      preview: createHash('sha256').update(await readBuffer(targetPreview.content.stream)).digest('hex'),
    }).toEqual(sourceMediaDigests);
  } finally { await target.close(); }

  const staleSource = (await bootstrapRelease(release, {
    configPath: configFile, loggerName: 'b17-stale-source', logDestination: 'stderr',
  })).runtime;
  await expect(staleSource.activateRelease('require-current'))
    .rejects.toThrow('Release or Base version downgrade requires a verified snapshot rollback');

  for (const storageKey of sourceMediaStorageKeys) {
    const backingObject = join(storageRoot, 'objects', storageKey);
    rmSync(backingObject);
    expect(existsSync(backingObject)).toBe(false);
  }
  const recovery = await runFullRestore({ bundleDirectory: bundle, operationRoot: operations,
    maintenanceUrl: maintenance.toString(), configFile, config });
  expect(recovery).toMatchObject({ objects: 2, restoredObjects: 2 });
  expect(recovery.quarantineName).toMatch(/^storeweave_retained_/);
  const quarantineUrl = new URL(liveUrl);
  quarantineUrl.pathname = `/${recovery.quarantineName}`;
  const quarantine = new Client({ connectionString: quarantineUrl.toString() });
  await quarantine.connect();
  try {
    expect((await quarantine.query('SELECT marker FROM b17_upgrade_probe')).rows)
      .toEqual([{ marker: 'candidate-only' }]);
    expect((await quarantine.query('SELECT status FROM platform_jobs WHERE id = $1', [sourceJob.id])).rows)
      .toEqual([{ status: 'completed' }]);
    expect((await quarantine.query('SELECT release_version FROM platform_release_history ORDER BY sequence DESC LIMIT 1')).rows)
      .toEqual([{ release_version: candidate.version }]);
  } finally { await quarantine.end(); }

  const restored = (await bootstrapRelease(release, {
    configPath: configFile, loggerName: 'b17-restored-source', logDestination: 'stderr',
  })).runtime;
  try {
    await restored.activateRelease('require-current');
    expect((await restored.database.pool.query(`SELECT id, occurrence_id, type, payload, payload_version, status,
      attempts, max_attempts, dedupe_key, run_at FROM platform_jobs WHERE id = $1`, [sourceJob.id])).rows)
      .toEqual([sourceJob]);
    expect((await restored.database.pool.query('SELECT tagline, footer_note FROM platform_site_settings')).rows)
      .toEqual([{ tagline: siteSentinel.tagline, footer_note: siteSentinel.footerNote }]);
    expect((await restored.database.pool.query("SELECT to_regclass('public.b17_upgrade_probe') AS table_name")).rows)
      .toEqual([{ table_name: null }]);
    expect(await restored.media.get(media.id)).toEqual(sourceMedia);
    const [restoredOriginal, restoredPreview] = await Promise.all([
      restored.storage.forNamespace('platform-media').open(sourceMedia.originalObjectId),
      restored.storage.forNamespace('platform-media').open(sourceMedia.previewObjectId!),
    ]);
    expect({
      original: createHash('sha256').update(await readBuffer(restoredOriginal.content.stream)).digest('hex'),
      preview: createHash('sha256').update(await readBuffer(restoredPreview.content.stream)).digest('hex'),
    }).toEqual(sourceMediaDigests);
  } finally { await restored.close(); }
});

function configuration(url: string, storageRoot: string) {
  return commerceConfigSchema.parse({ version: 1, store: { id: 'full-restore', name: 'Full restore' }, database: { url }, worker: { enabled: false },
    storage: { localRoot: storageRoot, staleObjectSeconds: 604800 }, security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
    extensions: [], logging: { level: 'error' } });
}

function installPgWrappers(bin: string, mountRoot: string): void {
  for (const tool of ['pg_dump', 'pg_restore']) {
    writeFileSync(join(bin, tool), `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { dirname } = require('node:path');
const args = process.argv.slice(2); const index = args.indexOf('--dbname') + 1;
if (index > 0) { const url = new URL(args[index]); url.hostname = 'host.docker.internal'; args[index] = url.toString(); }
const credentials = process.env.PGPASSFILE ? ['--env', 'PGPASSFILE=' + process.env.PGPASSFILE, '--mount', 'type=bind,source=' + dirname(process.env.PGPASSFILE) + ',target=' + dirname(process.env.PGPASSFILE) + ',readonly'] : [];
try { execFileSync('docker', ['run', '--rm', '--add-host', 'host.docker.internal:host-gateway', ...credentials, '--mount', ${JSON.stringify(`type=bind,source=${mountRoot},target=${mountRoot}`)}, '--entrypoint', ${JSON.stringify(tool)}, 'postgres:17-alpine', ...args], { stdio: 'inherit' }); }
catch (error) { process.exitCode = error.status || 1; }
`, { mode: 0o755 });
    chmodSync(join(bin, tool), 0o755);
  }
}

async function digestFile(file: string): Promise<{ byteSize: number; sha256: string }> {
  const hash = createHash('sha256'); let byteSize = 0;
  for await (const chunk of createReadStream(file)) { const bytes = Buffer.from(chunk); byteSize += bytes.byteLength; hash.update(bytes); }
  return { byteSize, sha256: hash.digest('hex') };
}

async function readBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

it('marks a failed recovery, then reclaims its scratch database and the objects it published', async () => {
  root = mkdtempSync(join(tmpdir(), 'storeweave-full-discard-'));
  const sourceStorage = join(root, 'source-storage'), targetStorage = join(root, 'target-storage');
  const bundle = join(root, 'bundle'), operations = join(root, 'operations'), bin = join(root, 'bin');
  for (const directory of [bundle, operations, bin]) mkdirSync(directory, { mode: 0o700 });
  container = await new PostgreSqlContainer('postgres:17-alpine').withDatabase('source_live')
    .withUsername('commerce').withPassword('full-discard-password').start();
  installPgWrappers(bin, root);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  const sourceUrl = new URL(container.getConnectionUri());
  sourceUrl.password = 'full-discard-password';
  const config = join(root, 'source.json');
  vi.stubEnv('SW_SIGNING_KEY_TEST', Buffer.alloc(32, 12).toString('base64url'));
  writeFileSync(config, JSON.stringify(configuration(sourceUrl.toString(), sourceStorage)), { mode: 0o600 });
  const runtime = (await bootstrapRelease(release, { configPath: config, loggerName: 'full-discard-source', logDestination: 'stderr' })).runtime;
  const maintenance = new URL(sourceUrl);
  maintenance.pathname = '/postgres';
  try {
    await runtime.migrate();
    await runtime.activateRelease('apply');
    const payload = Buffer.from('a discarded recovery leaves nothing behind');
    const saved = await runtime.storage.forNamespace('platform-storage').upload({ stream: Readable.from([payload]),
      originalName: 'discard.txt', contentType: 'text/plain', visibility: 'private' });
    await runtime.withReleaseSnapshot(async (evidence, client) => {
      const dump = join(bundle, 'database.dump');
      await writePgBackup(sourceUrl.toString(), dump, evidence.snapshotId);
      const storage = await captureStorageBackup(runtime, client, bundle);
      const digest = await digestFile(dump);
      const manifest = fullBackupSchema.parse({ schemaVersion: 1, kind: 'storeweave-full-backup', createdAt: new Date().toISOString(),
        release: { id: evidence.release.releaseId, version: evidence.release.releaseVersion, buildManifestChecksum: evidence.release.buildManifestChecksum },
        endpointChecksum: catalogDigest({ host: sourceUrl.hostname, port: sourceUrl.port || '5432', database: evidence.database.name }),
        evidence: (() => { const { snapshotId: _discarded, ...savedEvidence } = evidence; return savedEvidence; })(),
        database: { file: 'database.dump', byteSize: digest.byteSize, sha256: digest.sha256 }, storage: await writeStorageBackupCatalog(bundle, storage),
      });
      writeStorageBackupManifest(bundle, manifest);
    });

    // An existing live database with an open session: the media replay succeeds
    // and publishes bytes, then the cutover refuses. That is exactly the window
    // that used to leave orphan objects nothing could reclaim.
    const admin = new Client({ connectionString: maintenance.toString() });
    await admin.connect();
    try { await admin.query('CREATE DATABASE recovered_live'); } finally { await admin.end(); }
    const targetUrl = new URL(sourceUrl);
    targetUrl.pathname = '/recovered_live';
    const target = configuration(targetUrl.toString(), targetStorage);
    const targetConfig = join(root, 'target.json');
    writeFileSync(targetConfig, JSON.stringify(target), { mode: 0o600 });
    const holder = new Client({ connectionString: targetUrl.toString() });
    await holder.connect();
    let journalFile: string;
    try {
      await expect(runFullRestore({ bundleDirectory: bundle, operationRoot: operations, maintenanceUrl: maintenance.toString(),
        configFile: targetConfig, config: target })).rejects.toThrow();
      const recoveries = await listFullRecoveries(operations, maintenance.toString());
      expect(recoveries).toHaveLength(1);
      expect(recoveries[0]).toMatchObject({ phase: 'failed', scratchExists: true, restoredObjects: 1, discardable: true });
      journalFile = recoveries[0]!.journalFile;
      expect(readFullRecoveryJournal(journalFile, operations).journal.phase).toBe('failed');
      expect(existsSync(join(targetStorage, 'objects', saved.storageKey))).toBe(true);
    } finally { await holder.end(); }

    const scratchName = readFullRecoveryJournal(journalFile, operations).journal.scratch.name;
    const discarded = await discardFullRecovery({ journalFile, operationRoot: operations,
      maintenanceUrl: maintenance.toString(), config: target });
    expect(discarded).toEqual({ droppedScratch: true, removedObjects: 1 });
    expect(existsSync(join(targetStorage, 'objects', saved.storageKey))).toBe(false);
    expect(existsSync(journalFile)).toBe(false);
    const after = new Client({ connectionString: maintenance.toString() });
    await after.connect();
    try {
      const remaining = await after.query('SELECT oid FROM pg_catalog.pg_database WHERE datname = $1', [scratchName]);
      expect(remaining.rows).toHaveLength(0);
    } finally { await after.end(); }
    expect(await listFullRecoveries(operations, maintenance.toString())).toHaveLength(0);
  } finally { await runtime.close(); }
});
