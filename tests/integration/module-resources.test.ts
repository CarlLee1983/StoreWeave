import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger } from '@storeweave/contracts';
import { createRuntime, moduleResourceNamespace, type ModuleResources, type PlatformModule, type Runtime } from '@storeweave/kernel';
import { createTestDatabase } from './helpers';

const runtimes: Runtime[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function runtimeWith(modules: PlatformModule[], extra: Partial<Parameters<typeof createRuntime>[0]> = {}) {
  const url = await createTestDatabase();
  const root = mkdtempSync(join(tmpdir(), 'storeweave-module-resources-'));
  directories.push(root);
  const runtime = await createRuntime({
    release: { id: 'module-resources', version: '1.0.0', buildManifestChecksum: `sha256:${'5'.repeat(64)}` },
    roles: BASE_ROLES,
    config: baseConfigSchema.parse({ version: 1, store: { id: 'module-resources', name: 'Module Resources' }, database: { url },
      logging: { level: 'error' }, storage: { localRoot: join(root, 'storage') },
      security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] } }),
    secrets: {
      get: (key: string) => key === 'SW_SIGNING_KEY_TEST' ? Buffer.alloc(32, 3).toString('base64url') : undefined,
      has: (key: string) => key === 'SW_SIGNING_KEY_TEST', listNames: () => ['SW_SIGNING_KEY_TEST'],
    },
    logger: noopLogger, availableExtensions: {}, modules, ...extra,
  });
  runtimes.push(runtime);
  return runtime;
}

function resourceModule(name: string, resources: PlatformModule['resources'], received: Map<string, ModuleResources>): PlatformModule {
  return { name, version: '1.0.0', baseVersionRange: '^1.0.0', resources, bindResources: scopes => { received.set(name, scopes); } };
}

describe('declared module resources', () => {
  it('binds only the declared scopes, fixed to namespaces derived from each module id', async () => {
    const received = new Map<string, ModuleResources>();
    const runtime = await runtimeWith([
      resourceModule('files-alpha', ['cache', 'storage'], received),
      resourceModule('files-beta', ['cache'], received),
    ]);
    await runtime.migrate();

    const alpha = received.get('files-alpha')!;
    const beta = received.get('files-beta')!;
    expect(alpha.cache?.namespace).toBe(moduleResourceNamespace('files-alpha'));
    expect(alpha.storage?.namespace).toBe(moduleResourceNamespace('files-alpha'));
    expect(alpha.mutex).toBeDefined();
    expect(beta.cache?.namespace).toBe(moduleResourceNamespace('files-beta'));
    expect(beta.storage).toBeUndefined();
    expect(Object.isFrozen(alpha)).toBe(true);

    await alpha.cache!.set('shared-key', 'alpha', { ttlMs: 60_000 });
    await beta.cache!.set('shared-key', 'beta', { ttlMs: 60_000 });
    await beta.cache!.clear();
    await expect(alpha.cache!.get('shared-key')).resolves.toBe('alpha');

    const object = await alpha.storage!.upload({ stream: Readable.from(Buffer.from('hello')), originalName: 'a.txt', contentType: 'text/plain', visibility: 'private' });
    await expect(runtime.storage.forNamespace(moduleResourceNamespace('files-beta')).get(object.id)).resolves.toBeUndefined();
    await expect(alpha.storage!.get(object.id)).resolves.toMatchObject({ id: object.id, byteSize: 5 });
  });

  it('rejects a module that is also bound through the composition seam', async () => {
    const received = new Map<string, ModuleResources>();
    await expect(runtimeWith([resourceModule('files-alpha', ['cache'], received)], {
      cacheBindings: [{ module: 'files-alpha', bind: () => undefined }],
    })).rejects.toThrow('Duplicate cache binding for module "files-alpha"');
  });
});
