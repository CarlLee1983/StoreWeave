import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { catalogDigest, validateWorkOwnership } from '@storeweave/db';
import { noopLogger } from '@storeweave/contracts';
import { ProviderRegistry, defineExtension } from '@storeweave/extension-sdk';
import { release as base } from '../../packages/platform/bundle/src/releases/base';
import { release as commerce } from '../../packages/platform/bundle/src/releases/commerce';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { buildReleaseManifest, projectReleaseManifest } from '../../packages/platform/bundle/src/release-manifest';

const databaseConstructed = vi.hoisted(() => vi.fn());
vi.mock('@storeweave/db', async original => ({
  ...await original<typeof import('@storeweave/db')>(),
  Database: class { constructor() { databaseConstructed(); throw new Error('Database constructed'); } },
}));
const directories: string[] = [];
afterEach(() => {
  databaseConstructed.mockClear();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe('release build manifest', () => {
  it('contains SQL-free module pins and available extension jobs without running setup', () => {
    const setup = vi.fn(() => { throw new Error('setup must not run'); });
    const extension = defineExtension({ manifest: {
      id: 'manifest-probe', name: 'Probe', version: '1.0.0', platformVersion: '^1.0.0',
      configuration: z.object({}), permissions: [], subscribedEvents: [], registeredCommands: [],
      registeredQueries: [], registeredProviders: [], registeredJobs: ['ext.manifest-probe.run'],
    }, setup });
    const manifest = buildReleaseManifest({ ...base, availableExtensions: { 'manifest-probe': extension } });
    expect(manifest.modules.map(module => module.id)).toEqual(['platform', 'platform-cache', 'platform-identity', 'platform-ops']);
    expect(manifest.modules.find(module => module.id === 'platform')?.dataRelations)
      .toContain('platform_job_quarantine');
    expect(manifest.modules.find(module => module.id === 'platform')?.dataRelations)
      .toContain('platform_outbox_quarantine');
    expect(manifest.modules.find(module => module.id === 'platform-cache')?.dataRelations)
      .toEqual(['platform_cache']);
    expect(manifest.modules.find(module => module.id === 'platform-ops')?.migrations).toEqual([]);
    expect(manifest.availableExtensions[0]?.work.jobTypes).toEqual(['ext.manifest-probe.run']);
    expect(manifest.availableExtensions[0]).not.toHaveProperty('enabled');
    expect(JSON.stringify(manifest)).not.toContain('CREATE TABLE');
    expect(setup).not.toHaveBeenCalled();
    expect(databaseConstructed).not.toHaveBeenCalled();
  });

  it('keeps the same Commerce graph and checksum across valid store/provider configuration', () => {
    const expected = buildReleaseManifest(commerce);
    const config = commerce.config.schema.parse({ version: 1,
      store: { id: 'different-store', name: 'Different', currency: 'USD', locale: 'en', timezone: 'UTC' },
      database: { url: 'postgres://unused.invalid/different' },
    });
    const providers = new ProviderRegistry(noopLogger);
    const modules = commerce.createModules({ config, providers });
    const actual = projectReleaseManifest(commerce, [...modules].reverse());
    expect(catalogDigest(actual)).toBe(catalogDigest(expected));
    expect(expected.modules).toHaveLength(18);
  });

  it('rejects config-dependent job metadata before constructing a database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'storeweave-manifest-'));
    directories.push(directory);
    const configPath = join(directory, 'base.json');
    writeFileSync(configPath, JSON.stringify({ version: 1, store: { id: 'runtime', name: 'Runtime' },
      database: { url: 'postgres://unused.invalid/test' }, logging: { level: 'error' } }));
    await expect(bootstrapRelease({ ...base, createModules: ({ config }) => [{
      name: 'probe', version: '1.0.0', baseVersionRange: '^1.0.0',
      jobs: [{ type: `probe.${config.store.id}`, handler: async () => {} }],
    }] }, { configPath, loggerName: 'manifest-test' })).rejects.toThrow('metadata varies');
    expect(databaseConstructed).not.toHaveBeenCalled();
  });

  it('rejects ambiguous job ownership and preserves significant array order in hashes', () => {
    expect(() => projectReleaseManifest(base, [{
      name: 'probe', version: '1.0.0', baseVersionRange: '^1.0.0',
      jobs: [{ type: 'platform.event.deliver', handler: async () => {} }],
    }])).toThrow('declared by both');
    const manifest = buildReleaseManifest(base);
    const [platform] = manifest.modules;
    if (!platform) throw new Error('Missing platform module');
    expect(() => validateWorkOwnership([...manifest.modules, { ...platform, id: 'other' }])).toThrow('jobTypes ownership');
    expect(catalogDigest({ a: 1, b: { c: 2 } })).toBe(catalogDigest({ b: { c: 2 }, a: 1 }));
    expect(catalogDigest(['one', 'two'])).not.toBe(catalogDigest(['two', 'one']));
  });

  it('rejects an artifact checksum mismatch before constructing a database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'storeweave-manifest-'));
    directories.push(directory);
    const configPath = join(directory, 'base.json');
    writeFileSync(configPath, JSON.stringify(base.manifestConfig));
    vi.stubEnv('STOREWEAVE_BUILD_MANIFEST_SHA', 'sha256:changed');
    await expect(bootstrapRelease(base, { configPath, loggerName: 'manifest-test' }))
      .rejects.toThrow('does not match the built artifact');
    expect(databaseConstructed).not.toHaveBeenCalled();
  });
});
