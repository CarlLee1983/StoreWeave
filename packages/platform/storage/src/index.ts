import {
  AbortMultipartUploadCommand, CopyObjectCommand, DeleteObjectCommand, GetObjectCommand,
  ListMultipartUploadsCommand, ListObjectsV2Command, S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Pool } from 'pg';
import { sqlMigration, type MigrationSet } from '@storeweave/db';
import { signValue, verifySignedValue, type Keyring } from '@storeweave/crypto';

const NAMESPACE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_FILENAME = 255;
const DOWNLOAD_PURPOSE = 'storage-download';

export const storageMigrations: MigrationSet = {
  module: 'platform-storage',
  migrations: [sqlMigration('0001_init', 'expand', `
CREATE TABLE IF NOT EXISTS public.platform_storage_objects (
  id             uuid PRIMARY KEY,
  namespace      varchar(64) NOT NULL,
  owner_actor_id text,
  visibility     text NOT NULL CHECK (visibility IN ('public', 'private')),
  storage_key    text NOT NULL UNIQUE,
  original_name  text NOT NULL,
  content_type   text NOT NULL,
  byte_size      bigint,
  sha256         char(64),
  state          text NOT NULL CHECK (state IN ('uploading', 'ready', 'deleting', 'failed')),
  generation     integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at     timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  deleted_at     timestamptz
);
CREATE INDEX IF NOT EXISTS platform_storage_objects_namespace_list_idx
  ON public.platform_storage_objects (namespace, created_at DESC, id DESC) WHERE state = 'ready';
CREATE INDEX IF NOT EXISTS platform_storage_objects_stale_idx
  ON public.platform_storage_objects (updated_at) WHERE state IN ('uploading', 'deleting', 'failed');
`)],
};

export type StorageVisibility = 'public' | 'private';
export type StorageState = 'uploading' | 'ready' | 'deleting' | 'failed';

export interface StorageObject {
  readonly id: string;
  readonly namespace: string;
  readonly ownerActorId: string | null;
  readonly visibility: StorageVisibility;
  readonly storageKey: string;
  readonly originalName: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly state: StorageState;
  readonly generation: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface StoredContent {
  readonly stream: Readable;
  readonly byteSize: number | undefined;
}

export interface ObjectStore {
  put(key: string, stream: Readable): Promise<{ byteSize: number; sha256: string }>;
  open(key: string): Promise<StoredContent>;
  remove(key: string): Promise<void>;
  cleanupTemporary(options: { readonly olderThan: Date; readonly limit: number }): Promise<void>;
  healthCheck(): Promise<void>;
}

export interface LocalObjectStoreOptions { readonly root: string; }

function assertKey(key: string): void {
  if (!/^[a-z0-9][a-z0-9/_-]{0,255}$/.test(key) || key.includes('..')) throw new Error('Invalid storage key');
}

function counted(source: Readable): { stream: Transform; result: () => { byteSize: number; sha256: string } } {
  let byteSize = 0;
  const hash = createHash('sha256');
  const stream = new Transform({
    transform(chunk: Buffer | string, encoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding as BufferEncoding);
      byteSize += value.length;
      hash.update(value);
      callback(null, value);
    },
  });
  source.on('error', error => stream.destroy(error));
  return { stream, result: () => ({ byteSize, sha256: hash.digest('hex') }) };
}

/** Local objects are never addressed by a caller-supplied filesystem path. */
export class LocalObjectStore implements ObjectStore {
  private readonly root: string;
  private readonly objectsRoot: string;
  private readonly tempRoot: string;

  constructor(options: LocalObjectStoreOptions) {
    this.root = resolve(options.root);
    this.objectsRoot = join(this.root, 'objects');
    this.tempRoot = join(this.root, 'tmp');
  }

  private fileFor(key: string): string {
    assertKey(key);
    const file = resolve(this.objectsRoot, key);
    if (!file.startsWith(this.objectsRoot + sep)) throw new Error('Storage key escapes the configured root');
    return file;
  }

  private async ensureRoots(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('Storage roots must not be symbolic links');
    await mkdir(this.objectsRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
    for (const path of [this.objectsRoot, this.tempRoot]) {
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Storage roots must be real directories');
    }
  }

  private async ensureKeyParent(key: string, create: boolean): Promise<void> {
    const segments = key.split('/');
    let current = this.objectsRoot;
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      if (create) await mkdir(current, { recursive: true, mode: 0o700 });
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Storage object parent must be a real directory');
    }
  }

  async put(key: string, source: Readable): Promise<{ byteSize: number; sha256: string }> {
    await this.ensureRoots();
    const destination = this.fileFor(key);
    await this.ensureKeyParent(key, true);
    const temporary = join(this.tempRoot, `${randomUUID()}.upload`);
    const handle = await open(temporary, 'wx', 0o600);
    const output = createWriteStream(temporary, { fd: handle.fd, autoClose: false });
    const meter = counted(source);
    try {
      await pipeline(source, meter.stream, output);
      await handle.sync();
      await handle.close();
      await rename(temporary, destination);
      return meter.result();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async open(key: string): Promise<StoredContent> {
    await this.ensureRoots();
    await this.ensureKeyParent(key, false);
    const file = this.fileFor(key);
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Stored object is not a regular file');
    return { stream: createReadStream(file), byteSize: entry.size };
  }

  async remove(key: string): Promise<void> {
    await this.ensureRoots();
    try { await this.ensureKeyParent(key, false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    await rm(this.fileFor(key), { force: true });
  }

  async cleanupTemporary(options: { readonly olderThan: Date; readonly limit: number }): Promise<void> {
    await this.ensureRoots();
    const entries = await readdir(this.tempRoot, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (removed >= options.limit || !entry.isFile() || !/^[0-9a-f-]{36}\.upload$/.test(entry.name)) continue;
      const temporary = join(this.tempRoot, entry.name);
      const details = await lstat(temporary).catch(() => undefined);
      if (!details || !details.isFile() || details.isSymbolicLink() || details.mtime >= options.olderThan) continue;
      await rm(temporary, { force: true });
      removed += 1;
    }
  }

  async healthCheck(): Promise<void> { await this.ensureRoots(); }
}

export interface S3ObjectStoreOptions {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
  readonly prefix?: string;
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string };
}

/** S3 and S3-compatible backends stay private; application routes enforce visibility and expiry. */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: S3ObjectStoreOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix ? `${options.prefix.replace(/^\/+|\/+$/g, '')}/` : '';
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle ?? false,
      // A streamed body has no known decoded length. Newer SDK defaults can
      // request an optional checksum trailer and emit an invalid undefined
      // x-amz-decoded-content-length against S3-compatible servers. StoreWeave
      // already computes its own SHA-256, so only calculate when S3 requires it.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: options.credentials,
    });
  }

  private objectKey(key: string): string { assertKey(key); return `${this.prefix}${key}`; }

  async put(key: string, source: Readable): Promise<{ byteSize: number; sha256: string }> {
    const target = this.objectKey(key);
    const temporary = `${this.prefix}tmp/${randomUUID()}`;
    const meter = counted(source);
    try {
      // Upload handles unknown-length streams with multipart transfer. A bare
      // PutObject uses chunked transfer, which compatible servers may reject.
      const upload = new Upload({
        client: this.client,
        params: { Bucket: this.bucket, Key: temporary, Body: meter.stream },
        leavePartsOnError: false,
      });
      await Promise.all([
        upload.done(),
        pipeline(source, meter.stream),
      ]);
      await this.client.send(new CopyObjectCommand({
        Bucket: this.bucket, Key: target,
        CopySource: `${encodeURIComponent(this.bucket)}/${temporary.split('/').map(encodeURIComponent).join('/')}`,
      }));
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: temporary }));
      return meter.result();
    } catch (error) {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: temporary })).catch(() => undefined);
      throw error;
    }
  }

  async open(key: string): Promise<StoredContent> {
    const result: GetObjectCommandOutput = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
    if (!result.Body || !(result.Body instanceof Readable)) throw new Error('S3 returned no readable object body');
    return { stream: result.Body, byteSize: result.ContentLength };
  }

  async remove(key: string): Promise<void> { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) })); }

  async cleanupTemporary(options: { readonly olderThan: Date; readonly limit: number }): Promise<void> {
    const temporaryPrefix = `${this.prefix}tmp/`;
    const [objects, uploads] = await Promise.all([
      this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: temporaryPrefix, MaxKeys: options.limit })),
      this.client.send(new ListMultipartUploadsCommand({ Bucket: this.bucket, Prefix: temporaryPrefix, MaxUploads: options.limit })),
    ]);
    const staleObjects = (objects.Contents ?? []).filter(object => object.Key && object.LastModified && object.LastModified < options.olderThan).slice(0, options.limit);
    await Promise.all(staleObjects.map(object => this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: object.Key! }))));
    const remaining = Math.max(0, options.limit - staleObjects.length);
    const staleUploads = (uploads.Uploads ?? []).filter(upload => upload.Key && upload.UploadId && upload.Initiated && upload.Initiated < options.olderThan).slice(0, remaining);
    await Promise.all(staleUploads.map(upload => this.client.send(new AbortMultipartUploadCommand({
      Bucket: this.bucket, Key: upload.Key!, UploadId: upload.UploadId!,
    }))));
  }

  async healthCheck(): Promise<void> { await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: `${this.prefix}.health-never-exists` })).catch(error => {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (error as { name?: string }).name === 'NoSuchKey') return;
    throw error;
  }); }
}

type StoredRow = {
  id: string; namespace: string; owner_actor_id: string | null; visibility: StorageVisibility; storage_key: string;
  original_name: string; content_type: string; byte_size: string | null; sha256: string | null; state: StorageState;
  generation: number; created_at: Date; updated_at: Date;
};

function record(row: StoredRow): StorageObject {
  if (row.byte_size === null || row.sha256 === null) throw new Error(`Storage object ${row.id} is not ready`);
  return Object.freeze({
    id: row.id, namespace: row.namespace, ownerActorId: row.owner_actor_id, visibility: row.visibility,
    storageKey: row.storage_key, originalName: row.original_name, contentType: row.content_type,
    byteSize: Number(row.byte_size), sha256: row.sha256, state: row.state, generation: row.generation,
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  });
}

function assertNamespace(namespace: string): void { if (!NAMESPACE.test(namespace)) throw new Error('Invalid storage namespace'); }
function assertUpload(input: StorageUpload): void {
  if (!input.originalName || input.originalName.length > MAX_FILENAME || /[\u0000-\r\n]/.test(input.originalName)) throw new Error('Invalid upload filename');
  if (!/^[a-z]+\/[a-z0-9.+-]+(?:;.*)?$/i.test(input.contentType)) throw new Error('Invalid upload content type');
}

export interface StorageUpload {
  readonly stream: Readable;
  readonly originalName: string;
  readonly contentType: string;
  readonly visibility: StorageVisibility;
  readonly ownerActorId?: string;
}

/** A bounded transform used before either adapter receives caller controlled bytes. */
function limited(source: Readable, maximum: number): Readable {
  let seen = 0;
  const stream = new Transform({
    transform(chunk: Buffer | string, encoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding as BufferEncoding);
      seen += value.length;
      if (seen > maximum) {
        callback(new StorageLimitError(maximum));
        return;
      }
      callback(null, value);
    },
  });
  source.on('error', error => stream.destroy(error));
  void pipeline(source, stream).catch(() => undefined);
  return stream;
}

export class StorageLimitError extends Error {
  constructor(readonly maximum: number) {
    super(`Upload exceeds the ${maximum}-byte storage limit`);
    this.name = 'StorageLimitError';
  }
}

/**
 * Multipart Content-Type is a declaration, not evidence.  B09 deliberately
 * recognizes only formats for which a small magic prefix is unambiguous;
 * deeper image validation belongs to B10.
 */
export function validateUploadContentType(source: Readable, declared: string): Readable {
  const prefix: Buffer[] = [];
  let prefixSize = 0;
  const stream = new Transform({
    transform(chunk: Buffer | string, encoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding as BufferEncoding);
      if (prefixSize < 16) {
        const part = value.subarray(0, 16 - prefixSize);
        prefix.push(part);
        prefixSize += part.length;
      }
      callback(null, value);
    },
    flush(callback) {
      const bytes = Buffer.concat(prefix);
      const actual = bytes.subarray(0, 8);
      const expected = declared.toLowerCase().split(';', 1)[0];
      const matches = expected === 'image/png' ? actual.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        : expected === 'image/jpeg' ? actual.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
          : expected === 'image/gif' ? (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a')
            : expected === 'application/pdf' ? bytes.subarray(0, 5).toString('ascii') === '%PDF-'
              : true;
      callback(matches ? undefined : new StorageContentTypeError(expected));
    },
  });
  source.on('error', error => stream.destroy(error));
  void pipeline(source, stream).catch(() => undefined);
  return stream;
}

export class StorageContentTypeError extends Error {
  constructor(readonly contentType: string) {
    super(`Uploaded bytes do not match declared Content-Type ${contentType}`);
    this.name = 'StorageContentTypeError';
  }
}

export interface StorageListOptions { readonly limit?: number; readonly cursor?: { readonly createdAt: Date; readonly id: string }; }

export class StorageScope {
  constructor(private readonly manager: StorageManager, readonly namespace: string) { assertNamespace(namespace); }
  upload(input: StorageUpload): Promise<StorageObject> { return this.manager.upload(this.namespace, input); }
  get(id: string): Promise<StorageObject | undefined> { return this.manager.get(this.namespace, id); }
  list(options?: StorageListOptions): Promise<readonly StorageObject[]> { return this.manager.list(this.namespace, options); }
  delete(id: string): Promise<void> { return this.manager.delete(this.namespace, id); }
  open(id: string): Promise<{ object: StorageObject; content: StoredContent }> { return this.manager.open(this.namespace, id); }
  issueSignedDownload(id: string, keyring: Keyring, expiresAt: Date): Promise<{ urlToken: string; expiresAt: Date }> {
    return this.manager.issueSignedDownload(this.namespace, id, keyring, expiresAt);
  }
  openSignedDownload(token: string, keyring: Keyring, now: Date): Promise<{ object: StorageObject; content: StoredContent }> {
    return this.manager.openSignedDownload(this.namespace, token, keyring, now);
  }
}

export class StorageManager {
  private readonly scopes = new Map<string, StorageScope>();
  private cleanupTimer: NodeJS.Timeout | undefined;
  constructor(private readonly pool: Pool, private readonly store: ObjectStore, private readonly maximumUploadBytes = 20 * 1024 * 1024) {
    if (!Number.isSafeInteger(maximumUploadBytes) || maximumUploadBytes < 1) throw new Error('Invalid storage upload limit');
  }

  forNamespace(namespace: string): StorageScope {
    assertNamespace(namespace);
    let scope = this.scopes.get(namespace);
    if (!scope) { scope = new StorageScope(this, namespace); this.scopes.set(namespace, scope); }
    return scope;
  }

  async upload(namespace: string, input: StorageUpload): Promise<StorageObject> {
    assertNamespace(namespace); assertUpload(input);
    const id = randomUUID();
    const storageKey = `${namespace}/${id}`;
    await this.pool.query(`INSERT INTO public.platform_storage_objects
      (id, namespace, owner_actor_id, visibility, storage_key, original_name, content_type, state)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'uploading')`,
    [id, namespace, input.ownerActorId ?? null, input.visibility, storageKey, input.originalName, input.contentType]);
    try {
      const saved = await this.store.put(storageKey, limited(input.stream, this.maximumUploadBytes));
      const { rows } = await this.pool.query<StoredRow>(`UPDATE public.platform_storage_objects
        SET byte_size = $2, sha256 = $3, state = 'ready', updated_at = pg_catalog.clock_timestamp()
        WHERE id = $1 AND namespace = $4 AND state = 'uploading' RETURNING *`, [id, saved.byteSize, saved.sha256, namespace]);
      if (!rows[0]) throw new Error('Storage upload lost its metadata reservation');
      return record(rows[0]);
    } catch (error) {
      await this.store.remove(storageKey).catch(() => undefined);
      await this.pool.query(`UPDATE public.platform_storage_objects SET state = 'failed', updated_at = pg_catalog.clock_timestamp()
        WHERE id = $1 AND namespace = $2 AND state = 'uploading'`, [id, namespace]).catch(() => undefined);
      throw error;
    }
  }

  async get(namespace: string, id: string): Promise<StorageObject | undefined> {
    const { rows } = await this.pool.query<StoredRow>(`SELECT * FROM public.platform_storage_objects
      WHERE id = $1 AND namespace = $2 AND state = 'ready'`, [id, namespace]);
    return rows[0] ? record(rows[0]) : undefined;
  }

  async list(namespace: string, options: StorageListOptions = {}): Promise<readonly StorageObject[]> {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Storage list limit must be 1 to 100');
    const cursor = options.cursor;
    const { rows } = await this.pool.query<StoredRow>(`SELECT * FROM public.platform_storage_objects
      WHERE namespace = $1 AND state = 'ready'
        AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
      ORDER BY created_at DESC, id DESC LIMIT $4`, [namespace, cursor?.createdAt ?? null, cursor?.id ?? null, limit]);
    return rows.map(record);
  }

  async open(namespace: string, id: string): Promise<{ object: StorageObject; content: StoredContent }> {
    const object = await this.get(namespace, id);
    if (!object) throw new Error('Storage object not found');
    return { object, content: await this.store.open(object.storageKey) };
  }

  async delete(namespace: string, id: string): Promise<void> {
    const object = await this.get(namespace, id);
    if (!object) return;
    const marked = await this.pool.query(`UPDATE public.platform_storage_objects SET state = 'deleting', updated_at = pg_catalog.clock_timestamp()
      WHERE id = $1 AND namespace = $2 AND state = 'ready'`, [id, namespace]);
    if (marked.rowCount !== 1) throw new Error('Storage object state changed while deleting');
    try {
      await this.store.remove(object.storageKey);
      await this.pool.query('DELETE FROM public.platform_storage_objects WHERE id = $1 AND namespace = $2 AND state = \'deleting\'', [id, namespace]);
    } catch (error) {
      await this.pool.query(`UPDATE public.platform_storage_objects SET state = 'ready', updated_at = pg_catalog.clock_timestamp()
        WHERE id = $1 AND namespace = $2 AND state = 'deleting'`, [id, namespace]).catch(() => undefined);
      throw error;
    }
  }

  async issueSignedDownload(namespace: string, id: string, keyring: Keyring, expiresAt: Date): Promise<{ urlToken: string; expiresAt: Date }> {
    const object = await this.get(namespace, id);
    if (!object) throw new Error('Storage object not found');
    const payload = JSON.stringify({ namespace, id: object.id, generation: object.generation });
    return { urlToken: signValue(keyring, { purpose: DOWNLOAD_PURPOSE, payload, expiresAt }), expiresAt };
  }

  async openSignedDownload(namespace: string, token: string, keyring: Keyring, now: Date): Promise<{ object: StorageObject; content: StoredContent }> {
    const verified = verifySignedValue(keyring, { purpose: DOWNLOAD_PURPOSE, token, now });
    if (!verified.ok) throw new Error('Invalid or expired signed download URL');
    let payload: { namespace?: unknown; id?: unknown; generation?: unknown };
    try { payload = JSON.parse(verified.payload) as typeof payload; } catch { throw new Error('Invalid signed download URL'); }
    if (payload.namespace !== namespace || typeof payload.id !== 'string' || !Number.isSafeInteger(payload.generation)) {
      throw new Error('Invalid signed download URL');
    }
    const opened = await this.open(namespace, payload.id);
    if (opened.object.generation !== payload.generation) throw new Error('Signed download URL is no longer valid');
    return opened;
  }

  async cleanupStale(options: { readonly olderThan: Date; readonly limit?: number }): Promise<number> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error('Invalid storage cleanup limit');
    await this.store.cleanupTemporary({ olderThan: options.olderThan, limit });
    // Claim first: a SELECT FOR UPDATE on a pooled one-shot query would release
    // the row lock before the adapter call. `deleting` is hidden from readers
    // and makes this safe when API and worker cleanup overlap.
    const { rows } = await this.pool.query<Pick<StoredRow, 'id' | 'namespace' | 'storage_key'>>(`WITH candidates AS (
        SELECT id FROM public.platform_storage_objects
        WHERE state IN ('uploading', 'failed', 'deleting') AND updated_at < $1
        ORDER BY updated_at LIMIT $2 FOR UPDATE SKIP LOCKED
      )
      UPDATE public.platform_storage_objects AS object
      SET state = 'deleting', updated_at = pg_catalog.clock_timestamp()
      FROM candidates WHERE object.id = candidates.id
      RETURNING object.id, object.namespace, object.storage_key`, [options.olderThan, limit]);
    for (const row of rows) {
      try {
        await this.store.remove(row.storage_key);
        await this.pool.query(`DELETE FROM public.platform_storage_objects WHERE id = $1 AND namespace = $2 AND state = 'deleting'`, [row.id, row.namespace]);
      } catch {
        await this.pool.query(`UPDATE public.platform_storage_objects SET state = 'failed', updated_at = pg_catalog.clock_timestamp()
          WHERE id = $1 AND namespace = $2 AND state = 'deleting'`, [row.id, row.namespace]).catch(() => undefined);
      }
    }
    return rows.length;
  }

  healthCheck(): Promise<void> { return this.store.healthCheck(); }

  startCleanup(options: { readonly intervalMs: number; readonly staleAfterMs: number; readonly onError: (error: unknown) => void }): void {
    if (this.cleanupTimer) return;
    const run = () => void this.cleanupStale({ olderThan: new Date(Date.now() - options.staleAfterMs) }).catch(options.onError);
    run();
    this.cleanupTimer = setInterval(run, options.intervalMs);
    this.cleanupTimer.unref();
  }
  close(): void { if (this.cleanupTimer) clearInterval(this.cleanupTimer); this.cleanupTimer = undefined; }
}
