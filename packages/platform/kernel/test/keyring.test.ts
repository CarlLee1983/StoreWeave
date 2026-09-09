import { describe, expect, it } from 'vitest';
import { baseConfigSchema } from '@storeweave/config';
import type { SecretProvider } from '@storeweave/config';
import { resolveKeyring, requireKeyring } from '../src/keyring';

const LONG = 'x'.repeat(32);

function secretsFrom(values: Record<string, string>): SecretProvider {
  return {
    get: (name) => values[name],
    has: (name) => values[name] !== undefined && values[name] !== '',
    listNames: () => Object.keys(values).sort(),
  };
}

const config = (security?: unknown) => baseConfigSchema.parse({
  version: 1, store: { id: 'sw', name: 'S' }, database: { url: 'postgres://localhost/s' },
  ...(security ? { security } : {}),
});

describe('resolveKeyring', () => {
  it('returns undefined when no signing key is configured', () => {
    expect(resolveKeyring(config(), secretsFrom({}))).toBeUndefined();
  });

  it('builds a keyring from the configured references', () => {
    const keyring = resolveKeyring(
      config({ activeSigningKeyId: 'k2', signingKeys: [{ id: 'k1', secretRef: 'A' }, { id: 'k2', secretRef: 'B' }] }),
      secretsFrom({ A: LONG, B: `${LONG}2` }),
    );
    expect(keyring?.activeKeyId).toBe('k2');
    expect(keyring?.keyIds()).toEqual(['k1', 'k2']);
  });

  it('fails at startup when a declared secret is missing, naming the reference and not the value', () => {
    expect(() => resolveKeyring(config({ signingKeys: [{ id: 'k1', secretRef: 'MISSING_REF' }] }), secretsFrom({})))
      .toThrow(/MISSING_REF/);
  });

  it('fails at startup when a declared secret is too weak', () => {
    let thrown: unknown;
    try {
      resolveKeyring(config({ signingKeys: [{ id: 'k1', secretRef: 'A' }] }), secretsFrom({ A: 'short' }));
    } catch (error) { thrown = error; }
    expect(String(thrown)).toMatch(/32/);
    expect(String(thrown)).not.toContain('short');
  });
});

describe('requireKeyring', () => {
  it('returns the keyring when one is configured', () => {
    const keyring = resolveKeyring(config({ signingKeys: [{ id: 'k1', secretRef: 'A' }] }), secretsFrom({ A: LONG }));
    expect(requireKeyring({ keyring }, 'storage-download')).toBe(keyring);
  });

  it('explains which capability needs the missing configuration', () => {
    expect(() => requireKeyring({ keyring: undefined }, 'storage-download'))
      .toThrow(/storage-download.*security\.signingKeys|security\.signingKeys.*storage-download/s);
  });
});
