import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, createReadStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterEach, expect, it, vi } from 'vitest';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { release } from '@storeweave/selected-release';
import { catalogDigest } from '@storeweave/db';
import { commerceConfigSchema } from '@storeweave/config';
import { runFullRestore } from '../../tools/cli/src/full-restore';
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
    await expect(runFullRestore({ bundleDirectory: bundle, operationRoot: operations, maintenanceUrl: maintenance.toString(),
      configFile: targetConfig, config: target, resumeJournal: recovered.journalFile })).resolves.toMatchObject({
      journalFile: recovered.journalFile, objects: 1,
    });
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
