import { PLATFORM_VERSION, noopLogger } from '@storeweave/contracts';
import { baseConfigDefinition } from '@storeweave/config';
import { ProviderRegistry } from '@storeweave/extension-sdk';
import { release as runtimeRelease } from '../src/runtime';
import { httpAdapter } from '../../../../apps/api/src/releases/base';
import { seed } from '../../../../scripts/seeds/base';
import { baseTheme, editorialTheme } from '@storeweave/theme-base';
import { describe, expect, it } from 'vitest';
import { BASE_TARGET_KEYS, BaseReleaseSelectionError, baseReleaseDefinition, validateBaseReleaseDefinition } from '../src';
import { resolveBaseAdminProjection } from '../src/admin';
import { resolveBaseCliProjection } from '../src/cli';
import { resolveBaseConfigProjection } from '../src/config';
import { resolveBaseServerProjection } from '../src/server';
import { resolveBaseStorefrontProjection } from '../src/storefront';
import { resolveBaseWorkerProjection } from '../src/worker';

describe('Base release definition', () => {
  it('declares the exact legacy Base identity, selection, and six target keys', () => {
    const config = runtimeRelease.config.schema.parse(runtimeRelease.manifestConfig);
    const moduleKeys = runtimeRelease.createModules({ config, providers: new ProviderRegistry(noopLogger) })
      .map(module => module.name);

    expect(baseReleaseDefinition.manifest).toEqual({
      id: runtimeRelease.id,
      version: runtimeRelease.version,
      selected: {
        modules: moduleKeys,
        themes: ['base', 'editorial'],
        extensions: [],
      },
      targets: Object.fromEntries(Object.entries(BASE_TARGET_KEYS).map(([target, key]) => [target, { key }])),
      metadata: { baseVersion: PLATFORM_VERSION },
    });
  });

  it('resolves each target to the Base target contribution', () => {
    expect(resolveBaseServerProjection()).toEqual({ release: runtimeRelease, httpAdapter });
    expect(resolveBaseWorkerProjection()).toEqual({ target: 'worker', release: runtimeRelease });
    expect(resolveBaseAdminProjection()).toEqual({ enabled: false, contributions: [] });
    expect(resolveBaseCliProjection()).toEqual({
      release: runtimeRelease,
      seed,
      identity: {
        compatibleReleaseIds: ['base', 'file-requests'],
        commandName: 'storeweave', servicePrefix: 'storeweave', filesystemName: 'storeweave', configFilename: 'storeweave.yaml',
      },
      commands: { declared: [], contributions: [] },
    });
    expect(resolveBaseConfigProjection()).toEqual({ definition: baseConfigDefinition, defaultFilename: 'storeweave.yaml' });
    expect(resolveBaseStorefrontProjection()).toEqual({ themes: { base: baseTheme, editorial: editorialTheme } });
    expect(runtimeRelease.config).toBe(resolveBaseConfigProjection().definition);
    expect(runtimeRelease.availableThemes).toEqual(resolveBaseStorefrontProjection().themes);
  });

  it('rejects an incomplete Base selection before a target factory executes', () => {
    const invalid = {
      manifest: {
        ...baseReleaseDefinition.manifest,
        selected: { ...baseReleaseDefinition.manifest.selected, modules: ['platform-site', 'platform-auth'] },
      },
    };
    let executed = false;

    expect(() => resolveBaseServerProjection(invalid, {
      target: 'server', key: BASE_TARGET_KEYS.server,
      resolve: () => { executed = true; return { ignored: true }; },
    })).toThrow(new BaseReleaseSelectionError('modules must be exactly [platform-site, content, platform-auth]'));
    expect(executed).toBe(false);
  });

  it('rejects a target factory with a key different from the Base declaration', () => {
    expect(() => resolveBaseWorkerProjection(baseReleaseDefinition, {
      target: 'worker', key: 'commerce.worker.v1', resolve: () => ({ ignored: true }),
    })).toThrow('Release target "worker" requires factory key "base.worker.v1", received "commerce.worker.v1"');
  });

  it('rejects a changed Base target declaration', () => {
    const invalid = {
      manifest: {
        ...baseReleaseDefinition.manifest,
        targets: { ...baseReleaseDefinition.manifest.targets, admin: { key: 'base.admin.other' } },
      },
    };

    expect(() => validateBaseReleaseDefinition(invalid)).toThrow('target "admin" must use key "base.admin.v1"');
  });

  it('rejects a manifest with a different release identity', () => {
    const invalid = { manifest: { ...baseReleaseDefinition.manifest, id: 'commerce' } };
    expect(() => validateBaseReleaseDefinition(invalid)).toThrow('manifest.id must be "base"');
  });
});
