import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { BASE_ROLES, type ReleaseRoleCatalog } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { defineCommand, noopLogger, PlatformError } from '@storeweave/contracts';
import { createRuntime, moduleResourceNamespace, type ModuleResources, type PlatformModule, type Runtime } from '@storeweave/kernel';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { ModuleUploadsController } from '../../apps/api/src/controllers/module-uploads.controller';
import { createTestDatabase } from './helpers';

const ROLES: ReleaseRoleCatalog = {
  ...BASE_ROLES,
  uploader: { permissions: ['files:submit'], tokenAllowed: true, account: false },
};
const BOUNDARY = 'module-upload-boundary';

let directory: string;
let runtime: Runtime;
let app: NestFastifyApplication;
let uploaderToken: string;
let readonlyToken: string;
const received: ModuleResources[] = [];

const receiveCommand = defineCommand({
  name: 'test.files.receive',
  input: z.object({ storageObjectId: z.string().uuid(), title: z.string().min(1).max(40) }).strict(),
  output: z.object({ storageObjectId: z.string(), title: z.string(), ownerActorId: z.string().nullable() }),
  permission: 'files:submit',
});

const filesModule: PlatformModule = {
  name: 'files', version: '1.0.0', baseVersionRange: '^1.0.0',
  permissions: [{ key: 'files:submit', description: 'Submit a file', owner: 'files' }],
  resources: ['storage'],
  bindResources: resources => { received.push(resources); },
  commands: [{
    descriptor: receiveCommand,
    handler: async (input: z.infer<typeof receiveCommand.input>) => {
      if (input.title === 'reject me') throw PlatformError.validation('The receiving command rejected this file');
      const object = await received[0]!.storage!.get(input.storageObjectId);
      return { storageObjectId: input.storageObjectId, title: input.title, ownerActorId: object?.ownerActorId ?? null };
    },
  }],
  uploads: [{ name: 'attachment', contentTypes: ['text/plain'], command: 'test.files.receive' }],
};

function multipart(contentType: string, body: string): Buffer {
  return Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: ${contentType}\r\n\r\n${body}\r\n--${BOUNDARY}--\r\n`);
}

function post(url: string, token: string, contentType = 'text/plain', body = 'hello module') {
  return app.inject({
    method: 'POST', url, payload: multipart(contentType, body),
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  });
}

async function storedObjects(): Promise<{ state: string; owner_actor_id: string | null }[]> {
  const result = await runtime.database.pool.query<{ state: string; owner_actor_id: string | null }>(
    'SELECT state, owner_actor_id FROM platform_storage_objects WHERE namespace = $1 ORDER BY created_at', [moduleResourceNamespace('files')],
  );
  return result.rows;
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'storeweave-module-uploads-'));
  runtime = await createRuntime({
    release: { id: 'module-uploads', version: '1.0.0', buildManifestChecksum: `sha256:${'6'.repeat(64)}` },
    roles: ROLES,
    config: baseConfigSchema.parse({ version: 1, store: { id: 'module-uploads', name: 'Module Uploads' },
      database: { url: await createTestDatabase() }, logging: { level: 'error' },
      storage: { localRoot: join(directory, 'storage'), maxUploadBytes: 64 },
      security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] } }),
    secrets: {
      get: (key: string) => key === 'SW_SIGNING_KEY_TEST' ? Buffer.alloc(32, 3).toString('base64url') : undefined,
      has: (key: string) => key === 'SW_SIGNING_KEY_TEST', listNames: () => ['SW_SIGNING_KEY_TEST'],
    },
    logger: noopLogger, availableExtensions: {}, modules: [filesModule],
  });
  await runtime.migrate();
  const issue = (name: string, role: string) => runtime.database.transaction(tx => runtime.apiTokens.issue(tx, { name, role, ttlMs: 60 * 60_000 }));
  uploaderToken = (await issue('uploader', 'uploader')).secret;
  readonlyToken = (await issue('readonly', 'readonly')).secret;
  app = await createReleaseServer({
    runtime,
    httpAdapter: { releaseId: 'module-uploads', anonymousRole: null, startSession: async () => null, controllers: () => [ModuleUploadsController] },
    release: { version: '1.0.0', configPath: join(directory, 'unused.json') },
  });
});

afterAll(async () => {
  await app?.close();
  await runtime?.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('module upload intake', () => {
  it('stores the file privately under the module namespace and hands its id to the declared command as the caller', async () => {
    const response = await post('/api/v1/modules/files/uploads/attachment?title=Quarterly%20report', uploaderToken);
    expect(response.statusCode).toBe(201);
    const data = response.json().data as { storageObjectId: string; title: string; ownerActorId: string };
    expect(data).toMatchObject({ title: 'Quarterly report', ownerActorId: 'token:uploader' });
    const object = await received[0]!.storage!.get(data.storageObjectId);
    expect(object).toMatchObject({ visibility: 'private', contentType: 'text/plain', byteSize: 12 });
  });

  it('refuses callers without the receiving command’s permission before storing anything', async () => {
    const before = (await storedObjects()).length;
    expect((await post('/api/v1/modules/files/uploads/attachment?title=Nope', readonlyToken)).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/modules/files/uploads/attachment?title=Nope' })).statusCode).toBe(401);
    expect(await storedObjects()).toHaveLength(before);
  });

  it('answers 404 for modules or intakes that were never declared', async () => {
    expect((await post('/api/v1/modules/missing/uploads/attachment?title=x', uploaderToken)).statusCode).toBe(404);
    expect((await post('/api/v1/modules/files/uploads/other?title=x', uploaderToken)).statusCode).toBe(404);
  });

  it('rejects invalid command input and undeclared content types without keeping bytes', async () => {
    const before = (await storedObjects()).length;
    expect((await post('/api/v1/modules/files/uploads/attachment?title=ok&extra=1', uploaderToken)).statusCode).toBe(400);
    expect((await post('/api/v1/modules/files/uploads/attachment?title=ok&storageObjectId=00000000-0000-4000-8000-000000000000', uploaderToken)).statusCode).toBe(400);
    expect((await post('/api/v1/modules/files/uploads/attachment?title=ok', uploaderToken, 'application/pdf')).statusCode).toBe(400);
    expect((await post('/api/v1/modules/files/uploads/attachment?title=ok', uploaderToken, 'text/plain', 'x'.repeat(65))).statusCode).toBe(400);
    expect((await storedObjects()).filter(object => object.state === 'ready')).toHaveLength(before);
  });

  it('deletes the stored object when the receiving command fails', async () => {
    const before = (await storedObjects()).filter(object => object.state === 'ready').length;
    const response = await post('/api/v1/modules/files/uploads/attachment?title=reject%20me', uploaderToken);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('rejected this file');
    expect((await storedObjects()).filter(object => object.state === 'ready')).toHaveLength(before);
  });
});
