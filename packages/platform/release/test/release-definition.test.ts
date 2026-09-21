import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import * as root from '@storeweave/release';
import { resolveAdminProjection } from '@storeweave/release/admin';
import { assertCliProjectionRelease, CliProjectionContributionError, resolveCliProjection, validateCliCommandContributions } from '@storeweave/release/cli';
import { resolveConfigProjection } from '@storeweave/release/config';
import { resolveServerProjection } from '@storeweave/release/server';
import { resolveStorefrontProjection } from '@storeweave/release/storefront';
import { resolveWorkerProjection } from '@storeweave/release/worker';
import { ReleaseDefinitionValidationError, validateReleaseDefinition, type ReleaseDefinition } from '@storeweave/release';
import { ReleaseProjectionKeyMismatchError } from '../src/projection-factory';

function definition(overrides: Partial<ReleaseDefinition> = {}): ReleaseDefinition {
  return {
    manifest: {
      id: 'base', version: '1.0.0',
      selected: { modules: ['platform-auth'], themes: ['base'], extensions: ['mock-payment'] },
      targets: {
        server: { key: 'base-server' }, worker: { key: 'base-worker' }, admin: { key: 'base-admin' },
        cli: { key: 'base-cli' }, config: { key: 'base-config' }, storefront: { key: 'base-storefront' },
      },
      metadata: { configFile: 'base.yaml', featureFlags: { storefront: true } },
    },
    ...overrides,
  };
}

describe('ReleaseDefinition', () => {
  it('keeps the common root serializable and resolves each executable contribution only through its target subpath', () => {
    const release = definition();
    expect(JSON.parse(JSON.stringify(release.manifest))).toEqual(release.manifest);
    expect(root).not.toHaveProperty('resolveServerProjection');
    expect(resolveServerProjection(release, { target: 'server', key: 'base-server', resolve: ({ declaration }) => declaration.key })).toBe('base-server');
    expect(resolveWorkerProjection(release, { target: 'worker', key: 'base-worker', resolve: ({ declaration }) => declaration.key })).toBe('base-worker');
    expect(resolveAdminProjection(release, { target: 'admin', key: 'base-admin', resolve: ({ declaration }) => declaration.key })).toBe('base-admin');
    expect(resolveCliProjection(release, { target: 'cli', key: 'base-cli', resolve: ({ declaration }) => declaration.key })).toBe('base-cli');
    expect(resolveConfigProjection(release, { target: 'config', key: 'base-config', resolve: ({ declaration }) => ({ key: declaration.key }) })).toEqual({ key: 'base-config' });
    expect(resolveStorefrontProjection(release, { target: 'storefront', key: 'base-storefront', resolve: ({ declaration }) => ({ theme: declaration.key }) })).toEqual({ theme: 'base-storefront' });
  });

  it('rejects a Commerce server factory selected for a Base release', () => {
    expect(() => resolveServerProjection(definition(), {
      target: 'server', key: 'commerce-server', resolve: () => 'commerce contribution',
    })).toThrow(ReleaseProjectionKeyMismatchError);
    expect(() => resolveServerProjection(definition(), {
      target: 'server', key: 'commerce-server', resolve: () => 'commerce contribution',
    })).toThrow('Release target "server" requires factory key "base-server", received "commerce-server"');
  });

  it.each([
    ['a function in metadata', definition({ manifest: { ...definition().manifest, metadata: { executable: () => undefined } as any } })],
    ['a Date in metadata', definition({ manifest: { ...definition().manifest, metadata: { createdAt: new Date() } as any } })],
    ['a root executable field', { ...definition(), executable: () => undefined }],
    ['duplicate selected keys', definition({ manifest: { ...definition().manifest, selected: { ...definition().manifest.selected, modules: ['platform-auth', 'platform-auth'] } } })],
    ['an incomplete target declaration', definition({ manifest: { ...definition().manifest, targets: { ...definition().manifest.targets, admin: undefined } as any } })],
  ])('rejects %s with an actionable contract error', (_label, invalid) => {
    expect(() => validateReleaseDefinition(invalid)).toThrow(ReleaseDefinitionValidationError);
  });

  it.each([
    ['array toJSON that returns BigInt', (() => { const value: unknown[] = []; Object.defineProperty(value, 'toJSON', { value: () => 1n, enumerable: true }); return value; })()],
    ['hidden executable property', (() => { const value = { safe: true }; Object.defineProperty(value, 'hidden', { value: () => undefined }); return value; })()],
    ['symbol property', (() => { const value = { safe: true }; Object.defineProperty(value, Symbol('hidden'), { value: true, enumerable: true }); return value; })()],
    ['accessor property', (() => { const value = { safe: true }; Object.defineProperty(value, 'computed', { get: () => true, enumerable: true }); return value; })()],
    ['non-index executable array property', (() => { const value: unknown[] = []; Object.defineProperty(value, '4294967295', { value: () => undefined, enumerable: true }); return value; })()],
  ])('rejects JSON serialization bypasses: %s', (_label, metadata) => {
    expect(() => validateReleaseDefinition(definition({ manifest: { ...definition().manifest, metadata: metadata as any } })))
      .toThrow(ReleaseDefinitionValidationError);
  });

  it('preserves an own __proto__ metadata key as ordinary JSON data', () => {
    const metadata = JSON.parse('{"__proto__":"value"}');
    const validated = validateReleaseDefinition(definition({ manifest: { ...definition().manifest, metadata } }));
    expect(JSON.parse(JSON.stringify(validated.manifest.metadata))).toEqual(metadata);
    expect(Object.getPrototypeOf(validated.manifest.metadata)).toBeNull();
  });
});

describe('CLI command contributions', () => {
  it('rejects a CLI projection selected for a different runtime release', () => {
    expect(() => assertCliProjectionRelease('commerce', {
      compatibleReleaseIds: ['base', 'file-requests'],
      commandName: 'storeweave', servicePrefix: 'storeweave', filesystemName: 'storeweave', configFilename: 'storeweave.yaml',
    })).toThrow('CLI projection for releases [base, file-requests] cannot be used with release "commerce"');
    expect(() => assertCliProjectionRelease('file-requests', {
      compatibleReleaseIds: ['base', 'file-requests'],
      commandName: 'storeweave', servicePrefix: 'storeweave', filesystemName: 'storeweave', configFilename: 'storeweave.yaml',
    })).not.toThrow();
  });

  it('validates the complete declared command set before dispatch and lets the host own command names', async () => {
    const action = vi.fn();
    const commandSet = {
      declared: ['commerce:inspect'],
      contributions: [{ name: 'commerce:inspect', configure: (command: Command) => { command.action(action); } }],
    };
    const commands = validateCliCommandContributions('commerce', commandSet);
    const program = new Command();
    for (const contribution of commands) contribution.configure(program.command(contribution.name), undefined);

    await program.parseAsync(['node', 'test', 'commerce:inspect']);
    expect(action).toHaveBeenCalledOnce();
  });

  it('reports a missing command contribution with its release and command name', () => {
    expect(() => validateCliCommandContributions('commerce', {
      declared: ['content:backfill-legacy-media'],
    })).toThrow(new CliProjectionContributionError(
      'Release "commerce" is missing CLI contribution for command "content:backfill-legacy-media"',
    ));
  });

  it('rejects duplicate product command names and collisions with common commands', () => {
    const configure = (command: Command) => { command.action(() => undefined); };
    expect(() => validateCliCommandContributions('commerce', {
      declared: ['content:backfill-legacy-media'],
      contributions: [
        { name: 'content:backfill-legacy-media', configure },
        { name: 'content:backfill-legacy-media', configure },
      ],
    })).toThrow('Release "commerce" has duplicate CLI contribution for command "content:backfill-legacy-media"');
    expect(() => validateCliCommandContributions('commerce', {
      declared: ['migrate'], contributions: [{ name: 'migrate', configure }],
    }, ['migrate'])).toThrow('Release "commerce" has duplicate CLI command "migrate"');
  });
});
