import { describe, expect, it } from 'vitest';
import { createKeyring } from '../src/keyring';

const keys = [
  { id: 'k1', secret: 'secret-one-secret-one-secret-one' },
  { id: 'k2', secret: 'secret-two-secret-two-secret-two' },
];

describe('keyring', () => {
  it('exposes the active key and every configured key id', () => {
    const keyring = createKeyring({ activeKeyId: 'k2', keys });
    expect(keyring.activeKeyId).toBe('k2');
    expect(keyring.keyIds()).toEqual(['k1', 'k2']);
  });

  it('rejects an active key id that is not configured', () => {
    expect(() => createKeyring({ activeKeyId: 'k9', keys })).toThrow(/active signing key/i);
  });

  it('rejects duplicate key ids', () => {
    expect(() => createKeyring({ activeKeyId: 'k1', keys: [keys[0], keys[0]] })).toThrow(/duplicate/i);
  });

  it('rejects an empty keyring instead of silently signing with nothing', () => {
    expect(() => createKeyring({ activeKeyId: 'k1', keys: [] })).toThrow(/at least one/i);
  });

  it('rejects a secret that is too short to carry the advertised strength', () => {
    expect(() => createKeyring({ activeKeyId: 'k1', keys: [{ id: 'k1', secret: 'short' }] }))
      .toThrow(/32/);
  });

  it('derives different material per purpose so one purpose cannot forge another', () => {
    const keyring = createKeyring({ activeKeyId: 'k1', keys });
    const a = keyring.derive('storage-download', 'k1');
    const b = keyring.derive('password-reset', 'k1');
    expect(a.equals(b)).toBe(false);
  });

  it('derives different material per key id', () => {
    const keyring = createKeyring({ activeKeyId: 'k1', keys });
    expect(keyring.derive('storage-download', 'k1').equals(keyring.derive('storage-download', 'k2'))).toBe(false);
  });

  it('derives deterministically across instances', () => {
    const a = createKeyring({ activeKeyId: 'k1', keys }).derive('storage-download', 'k1');
    const b = createKeyring({ activeKeyId: 'k2', keys }).derive('storage-download', 'k1');
    expect(a.equals(b)).toBe(true);
  });

  it('refuses to derive from an unknown key id', () => {
    const keyring = createKeyring({ activeKeyId: 'k1', keys });
    expect(() => keyring.derive('storage-download', 'k9')).toThrow(/unknown signing key/i);
  });

  it('rejects a purpose outside the allowed shape', () => {
    const keyring = createKeyring({ activeKeyId: 'k1', keys });
    for (const bad of ['', 'A', 'has space', 'with.dot', 'with_underscore', '1leading', 'x'.repeat(65)]) {
      expect(() => keyring.derive(bad, 'k1')).toThrow(/purpose/i);
    }
  });

  it('rejects a key id outside the allowed shape', () => {
    expect(() => createKeyring({ activeKeyId: 'BAD', keys: [{ id: 'BAD', secret: 'x'.repeat(32) }] }))
      .toThrow(/key id/i);
  });
});
