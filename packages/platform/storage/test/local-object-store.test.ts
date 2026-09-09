import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { LocalObjectStore, StorageContentTypeError, validateUploadContentType } from '../src';

async function read(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('LocalObjectStore', () => {
  it('streams to an opaque server key and returns byte count plus SHA-256', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storeweave-storage-'));
    try {
      const store = new LocalObjectStore({ root });
      const payload = Buffer.from('streaming storage payload');
      const saved = await store.put('platform-storage/object-1', Readable.from([payload]));
      expect(saved).toEqual({ byteSize: payload.length, sha256: createHash('sha256').update(payload).digest('hex') });
      const opened = await store.open('platform-storage/object-1');
      expect(opened.byteSize).toBe(payload.length);
      await expect(read(opened.stream)).resolves.toEqual(payload);
      await store.remove('platform-storage/object-1');
      await expect(store.open('platform-storage/object-1')).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('never follows a symbolic link presented as an object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storeweave-storage-'));
    try {
      const objectDir = join(root, 'objects', 'platform-storage');
      await mkdir(objectDir, { recursive: true });
      await symlink('/etc/hosts', join(objectDir, 'linked'));
      const store = new LocalObjectStore({ root });
      await expect(store.open('platform-storage/linked')).rejects.toThrow('regular file');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('removes only stale, regular temporary upload files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storeweave-storage-'));
    try {
      const temporary = join(root, 'tmp', '11111111-1111-1111-1111-111111111111.upload');
      await mkdir(join(root, 'tmp'), { recursive: true });
      await writeFile(temporary, 'interrupted upload');
      await utimes(temporary, new Date(0), new Date(0));
      const store = new LocalObjectStore({ root });
      await store.cleanupTemporary({ olderThan: new Date(1), limit: 1 });
      await expect(store.open('platform-storage/does-not-exist')).rejects.toThrow();
      await expect(lstat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('validateUploadContentType', () => {
  it('rejects a forged concrete MIME type without buffering the object', async () => {
    const stream = validateUploadContentType(Readable.from([Buffer.from('%PDF-1.7')]), 'image/png');
    await expect(read(stream)).rejects.toBeInstanceOf(StorageContentTypeError);
  });

  it('accepts generic binary content', async () => {
    const payload = Buffer.from('unknown binary');
    await expect(read(validateUploadContentType(Readable.from([payload]), 'application/octet-stream'))).resolves.toEqual(payload);
  });
});
