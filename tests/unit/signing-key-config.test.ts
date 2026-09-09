import { describe, expect, it } from 'vitest';
import { baseConfigSchema, commerceConfigSchema } from '@storeweave/config';

const base = { version: 1, store: { id: 'base-test', name: 'Base' }, database: { url: 'postgres://localhost/base' } };
const withSecurity = (security: unknown) => ({ ...base, security });

describe('signing key configuration', () => {
  it('defaults to no signing keys so an existing deployment keeps parsing', () => {
    for (const schema of [baseConfigSchema, commerceConfigSchema]) {
      expect(schema.parse(base).security).toEqual({ signingKeys: [] });
    }
  });

  it('accepts a keyring and reports the active key', () => {
    const parsed = baseConfigSchema.parse(withSecurity({
      activeSigningKeyId: 'k2',
      signingKeys: [{ id: 'k1', secretRef: 'SW_SIGNING_KEY_K1' }, { id: 'k2', secretRef: 'SW_SIGNING_KEY_K2' }],
    }));
    expect(parsed.security.activeSigningKeyId).toBe('k2');
    expect(parsed.security.signingKeys.map((key) => key.id)).toEqual(['k1', 'k2']);
  });

  it('defaults the active key to the only configured key', () => {
    const parsed = baseConfigSchema.parse(withSecurity({ signingKeys: [{ id: 'k1', secretRef: 'SW_SIGNING_KEY_K1' }] }));
    expect(parsed.security.activeSigningKeyId).toBe('k1');
  });

  it('requires an explicit active key once more than one is configured', () => {
    const result = baseConfigSchema.safeParse(withSecurity({
      signingKeys: [{ id: 'k1', secretRef: 'A' }, { id: 'k2', secretRef: 'B' }],
    }));
    expect(result.success).toBe(false);
  });

  it('rejects an active key that is not in the keyring', () => {
    expect(baseConfigSchema.safeParse(withSecurity({
      activeSigningKeyId: 'k9', signingKeys: [{ id: 'k1', secretRef: 'A' }],
    })).success).toBe(false);
  });

  it('rejects an active key with no keyring at all', () => {
    expect(baseConfigSchema.safeParse(withSecurity({ activeSigningKeyId: 'k1' })).success).toBe(false);
  });

  it('rejects duplicate key ids', () => {
    expect(baseConfigSchema.safeParse(withSecurity({
      activeSigningKeyId: 'k1', signingKeys: [{ id: 'k1', secretRef: 'A' }, { id: 'k1', secretRef: 'B' }],
    })).success).toBe(false);
  });

  it('rejects key ids that could not survive a token round trip', () => {
    for (const id of ['K1', 'has space', 'has.dot', '1leading', '']) {
      expect(baseConfigSchema.safeParse(withSecurity({ signingKeys: [{ id, secretRef: 'A' }] })).success).toBe(false);
    }
  });

  it('never accepts an inline secret in place of a reference', () => {
    expect(baseConfigSchema.safeParse(withSecurity({
      signingKeys: [{ id: 'k1', secret: 'inline-secret-inline-secret-1234' }],
    })).success).toBe(false);
  });
});
