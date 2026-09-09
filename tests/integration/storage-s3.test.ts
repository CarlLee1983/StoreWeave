import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CreateBucketCommand, CreateMultipartUploadCommand, GetObjectCommand,
  ListMultipartUploadsCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { S3ObjectStore } from '@storeweave/storage';

const accessKeyId = 'minioadmin';
const secretAccessKey = 'minioadmin';
let minio: StartedTestContainer;
let endpoint: string;
let bucket: string;

beforeAll(async () => {
  minio = await new GenericContainer('minio/minio:RELEASE.2025-04-22T22-12-26Z')
    .withEnvironment({ MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey })
    .withExposedPorts(9000)
    .withCommand(['server', '/data'])
    .start();
  endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
  bucket = `storeweave-${randomUUID().slice(0, 8)}`;
  const client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
}, 120_000);

afterAll(async () => { await minio?.stop(); });

describe('S3ObjectStore against a MinIO S3-compatible server', () => {
  it('promotes a streamed temporary object, serves it, and deletes it', async () => {
    const store = new S3ObjectStore({ bucket, region: 'us-east-1', endpoint, forcePathStyle: true, prefix: 'b09', credentials: { accessKeyId, secretAccessKey } });
    const payload = Buffer.from('s3-compatible stream');
    await expect(store.put('platform-storage/object-1', Readable.from([payload]))).resolves.toMatchObject({ byteSize: payload.length });
    const opened = await store.open('platform-storage/object-1');
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(payload);
    await store.remove('platform-storage/object-1');
    await expect(store.open('platform-storage/object-1')).rejects.toThrow();
  });

  it('removes abandoned temporary objects from an interrupted upload', async () => {
    const store = new S3ObjectStore({ bucket, region: 'us-east-1', endpoint, forcePathStyle: true, prefix: 'b09', credentials: { accessKeyId, secretAccessKey } });
    const client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: 'b09/tmp/abandoned', Body: 'orphaned bytes' }));
    await store.cleanupTemporary({ olderThan: new Date(Date.now() + 60_000), limit: 10 });
    await expect(client.send(new GetObjectCommand({ Bucket: bucket, Key: 'b09/tmp/abandoned' }))).rejects.toThrow();
  });

  it('aborts abandoned multipart uploads', async () => {
    const store = new S3ObjectStore({ bucket, region: 'us-east-1', endpoint, forcePathStyle: true, prefix: 'b09', credentials: { accessKeyId, secretAccessKey } });
    const client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
    const started = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: 'b09/tmp/interrupted-multipart' }));
    expect(started.UploadId).toBeTruthy();
    await store.cleanupTemporary({ olderThan: new Date(Date.now() + 60_000), limit: 10 });
    const remaining = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: 'b09/tmp/' }));
    expect(remaining.Uploads?.some(upload => upload.UploadId === started.UploadId) ?? false).toBe(false);
  });
});
