import { createHash } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { catalogDigest } from '@storeweave/db';
import type { Runtime } from '@storeweave/kernel';
import { pairedSnapshotSchema, readPrivateJson } from './read-release-snapshot';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const objectId = z.string().uuid();
const storageKey = z.string().regex(/^[a-z0-9][a-z0-9/_-]{0,255}$/);

const entrySchema = z.object({
  id: objectId,
  namespace: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  storageKey,
  byteSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256,
  file: z.string().regex(/^objects\/[a-f0-9]{64}$/),
}).strict();

export const storageBackupSchema = z.object({
  schemaVersion: z.literal(1),
  objects: z.array(entrySchema),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>(), keys = new Set<string>();
  for (const [index, object] of value.objects.entries()) {
    if (ids.has(object.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['objects', index, 'id'], message: 'Duplicate storage object id' });
    if (keys.has(object.storageKey)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['objects', index, 'storageKey'], message: 'Duplicate storage key' });
    ids.add(object.id); keys.add(object.storageKey);
  }
});

export type StorageBackup = z.infer<typeof storageBackupSchema>;

const storageCatalogSchema = z.object({
  file: z.literal('storage.json'), byteSize: z.number().int().positive().max(128 * 1024 * 1024), sha256,
  objectCount: z.number().int().min(0).max(1_000_000),
}).strict();
export type StorageCatalog = z.infer<typeof storageCatalogSchema>;

export const fullBackupSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('storeweave-full-backup'),
  createdAt: z.string().datetime(),
  release: z.object({ id: z.enum(['base', 'commerce']), version: z.string().min(1), buildManifestChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
  /**
   * Provenance only, intentionally not enforced on restore. Every other
   * snapshot path compares this against the target endpoint, but a full bundle
   * exists to be recovered onto a different cluster — checking it would make
   * off-site recovery, the whole point of the bundle, fail closed.
   */
  endpointChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  evidence: pairedSnapshotSchema.shape.evidence,
  database: z.object({ file: z.literal('database.dump'), byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), sha256 }).strict(),
  storage: storageCatalogSchema,
}).strict();

export type FullBackup = z.infer<typeof fullBackupSchema>;

interface StoredRow {
  id: string;
  namespace: string;
  storage_key: string;
  byte_size: string;
  sha256: string;
}

function sync(path: string): void {
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

async function hashFile(path: string): Promise<{ byteSize: number; sha256: string }> {
  const digest = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of createReadStream(path)) {
    const value = Buffer.from(chunk);
    byteSize += value.byteLength;
    digest.update(value);
  }
  return { byteSize, sha256: digest.digest('hex') };
}

/**
 * The digest is taken by a stage inside the pipeline, not by a `'data'`
 * listener: a listener switches the source to flowing mode on its own and only
 * happens to lose nothing while `pipeline` attaches its pipe in the same tick.
 * A missed chunk there surfaces as a checksum mismatch rather than an error.
 */
function metered(): { stream: Transform; result: () => { byteSize: number; sha256: string } } {
  const digest = createHash('sha256');
  let byteSize = 0;
  const stream = new Transform({
    transform(chunk: Buffer | string, encoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding as BufferEncoding);
      byteSize += value.byteLength;
      digest.update(value);
      callback(null, value);
    },
  });
  return { stream, result: () => ({ byteSize, sha256: digest.digest('hex') }) };
}

async function copyAndVerify(source: NodeJS.ReadableStream, target: string, expected: { byteSize: number; sha256: string }): Promise<void> {
  const temporary = `${target}.partial`;
  const meter = metered();
  const sink = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
  try {
    await pipeline(source, meter.stream, sink);
    const saved = meter.result();
    if (saved.byteSize !== expected.byteSize || saved.sha256 !== expected.sha256) throw new Error('Storage object bytes do not match its persisted digest');
    sync(temporary);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Captures every ready object while `client` holds the same exported snapshot
 * as the PostgreSQL dump. The caller has already stopped all writers, so the
 * bytes cannot change between this metadata read and the streamed copy.
 */
export async function captureStorageBackup(runtime: Runtime, client: PoolClient, directory: string): Promise<StorageBackup> {
  const root = resolve(directory);
  const objectsDirectory = join(root, 'objects');
  mkdirSync(objectsDirectory, { recursive: true, mode: 0o700 });
  const result = await client.query<StoredRow>(`SELECT id::text, namespace, storage_key, byte_size::text, sha256
    FROM public.platform_storage_objects WHERE state = 'ready'
    ORDER BY namespace ASC, id ASC`);
  const objects: StorageBackup['objects'] = [];
  for (const row of result.rows) {
    const entry = entrySchema.parse({
      id: row.id, namespace: row.namespace, storageKey: row.storage_key,
      byteSize: Number(row.byte_size), sha256: row.sha256, file: `objects/${row.sha256}`,
    });
    const opened = await runtime.storage.forNamespace(entry.namespace).open(entry.id);
    if (opened.object.storageKey !== entry.storageKey || opened.object.byteSize !== entry.byteSize || opened.object.sha256 !== entry.sha256) {
      throw new Error('Storage object metadata changed during backup');
    }
    const target = join(root, entry.file);
    if (lstatSync(target, { throwIfNoEntry: false })) {
      const actual = await hashFile(target);
      if (actual.byteSize !== entry.byteSize || actual.sha256 !== entry.sha256) throw new Error('Storage backup content-addressed object mismatch');
      // The backup still consumes this source stream: a stale database row may
      // otherwise look valid merely because another object has the same hash.
      const observed = await hashReadable(opened.content.stream);
      if (observed.byteSize !== entry.byteSize || observed.sha256 !== entry.sha256) throw new Error('Storage object bytes do not match its persisted digest');
    } else await copyAndVerify(opened.content.stream, target, entry);
    objects.push(entry);
  }
  sync(objectsDirectory);
  return storageBackupSchema.parse({ schemaVersion: 1, objects });
}

async function hashReadable(source: NodeJS.ReadableStream): Promise<{ byteSize: number; sha256: string }> {
  const digest = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of source) {
    const value = Buffer.from(chunk);
    byteSize += value.byteLength;
    digest.update(value);
  }
  return { byteSize, sha256: digest.digest('hex') };
}

/** Verify every archived byte before a restore changes a live database. */
export async function readStorageBackup(directory: string, raw: unknown): Promise<StorageBackup> {
  const backup = storageBackupSchema.parse(raw);
  const root = resolve(directory);
  const objectsDirectory = join(root, 'objects');
  const objectsStat = lstatSync(objectsDirectory);
  if (!objectsStat.isDirectory() || objectsStat.isSymbolicLink()) throw new Error('Storage backup objects directory must be a real directory');
  for (const entry of backup.objects) {
    const path = join(root, entry.file);
    if (!path.startsWith(`${root}/`)) throw new Error('Storage backup path escapes its bundle');
    const details = lstatSync(path);
    if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 || (details.mode & 0o077)) throw new Error('Storage backup object must be a private regular file');
    const actual = await hashFile(path);
    if (actual.byteSize !== entry.byteSize || actual.sha256 !== entry.sha256) throw new Error('Storage backup object checksum mismatch');
  }
  return backup;
}

/** The outer manifest stays small; the potentially large object catalogue has its own bounded, checksummed file. */
export async function writeStorageBackupCatalog(directory: string, backup: StorageBackup): Promise<StorageCatalog> {
  const file = join(resolve(directory), 'storage.json');
  writeFileSync(file, `${JSON.stringify(backup)}\n`, { flag: 'wx', mode: 0o600 });
  sync(file);
  const digest = await hashFile(file);
  return storageCatalogSchema.parse({ file: 'storage.json', byteSize: digest.byteSize, sha256: digest.sha256, objectCount: backup.objects.length });
}

export async function readStorageBackupCatalog(directory: string, raw: unknown): Promise<StorageBackup> {
  const catalog = storageCatalogSchema.parse(raw);
  const root = resolve(directory);
  const file = join(root, catalog.file);
  const details = lstatSync(file);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 || (details.mode & 0o077)) throw new Error('Storage backup catalogue must be a private regular file');
  const digest = await hashFile(file);
  if (digest.byteSize !== catalog.byteSize || digest.sha256 !== catalog.sha256) throw new Error('Storage backup catalogue checksum mismatch');
  const backup = await readStorageBackup(root, readPrivateJson(file, 128 * 1024 * 1024));
  if (backup.objects.length !== catalog.objectCount) throw new Error('Storage backup catalogue object count mismatch');
  return backup;
}

/**
 * Rehydrates exactly the objects recorded in a verified bundle. Extra keys in
 * an S3 prefix are intentionally left alone: the bucket can be shared and a
 * restore must never infer ownership from an unlisted key.
 *
 * Returns the keys this call published, so a caller that fails later can take
 * its own bytes back out. Entries are handed over in bounded chunks: the
 * metadata lookup is one statement per chunk, and a bundle may hold a million
 * objects.
 */
export async function restoreStorageBackup(runtime: Runtime, directory: string, backup: StorageBackup): Promise<readonly string[]> {
  const root = resolve(directory);
  const created: string[] = [];
  for (let index = 0; index < backup.objects.length; index += RESTORE_CHUNK) {
    const chunk = backup.objects.slice(index, index + RESTORE_CHUNK).map(entry => ({
      namespace: entry.namespace, id: entry.id, storageKey: entry.storageKey,
      byteSize: entry.byteSize, sha256: entry.sha256, open: () => createReadStream(join(root, entry.file)),
    }));
    created.push(...await runtime.storage.restoreExactBatch(chunk));
  }
  return created;
}

const RESTORE_CHUNK = 500;

/** The restored database must describe exactly the same ready objects as the bundle. */
export async function assertStorageBackupMatchesDatabase(runtime: Runtime, backup: StorageBackup): Promise<void> {
  const result = await runtime.database.pool.query<StoredRow>(`SELECT id::text, namespace, storage_key, byte_size::text, sha256
    FROM public.platform_storage_objects WHERE state = 'ready' ORDER BY namespace ASC, id ASC`);
  const actual = result.rows.map(row => entrySchema.parse({
    id: row.id, namespace: row.namespace, storageKey: row.storage_key,
    byteSize: Number(row.byte_size), sha256: row.sha256, file: `objects/${row.sha256}`,
  }));
  const expected = [...backup.objects].sort((left, right) => left.namespace.localeCompare(right.namespace) || left.id.localeCompare(right.id));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Restored database ready objects do not match the backup manifest');
}

/** Writes a private JSON manifest as the final file in a staged bundle. */
export function writeStorageBackupManifest(directory: string, value: unknown): void {
  const file = join(resolve(directory), 'manifest.json');
  writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  sync(file);
  sync(dirname(file));
}
