import { describe, expect, it } from 'vitest';
import { createKeyring, generateSigningKeySecret } from '../src/keyring';

const keys = [
  { id: 'k1', secret: '11'.repeat(32) },
  { id: 'k2', secret: '22'.repeat(32) },
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
    // 16 個 hex 字元只有 8 bytes 的材料。
    expect(() => createKeyring({ activeKeyId: 'k1', keys: [{ id: 'k1', secret: 'ab'.repeat(8) }] }))
      .toThrow(/32 bytes/);
  });

  it('rejects a secret that is not encoded key material at all', () => {
    expect(() => createKeyring({ activeKeyId: 'k1', keys: [{ id: 'k1', secret: 'short' }] }))
      .toThrow(/base64url|hex/i);
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
    expect(() => createKeyring({ activeKeyId: 'BAD', keys: [{ id: 'BAD', secret: 'ab'.repeat(32) }] }))
      .toThrow(/key id/i);
  });
});

describe('keyring hardening', () => {
  it('returns a copy so a caller cannot wipe the cached key material', () => {
    const keyring = createKeyring({ activeKeyId: 'k1', keys });
    const first = keyring.derive('storage-download', 'k1');
    first.fill(0);
    expect(keyring.derive('storage-download', 'k1').equals(first)).toBe(false);
  });

  it('names the real problem when a key id is not a string', () => {
    const keyring = createKeyring({ activeKeyId: 'k1', keys });
    expect(() => keyring.derive('storage-download', undefined as unknown as string)).toThrow(/key id/i);
  });

  it('requires the secret to decode to real key material, not just be long', () => {
    // 32 個字元的 hex 只有 16 bytes 的材料，正是最容易誤用的一種寫法。
    expect(() => createKeyring({ activeKeyId: 'k1', keys: [{ id: 'k1', secret: 'a'.repeat(32) }] })).toThrow(/32 bytes/);
    expect(() => createKeyring({ activeKeyId: 'k1', keys: [{ id: 'k1', secret: 'please-change-me-please-change-me' }] })).toThrow();
  });

  it('accepts a secret produced by the documented generator', () => {
    const secret = generateSigningKeySecret();
    expect(() => createKeyring({ activeKeyId: 'k1', keys: [{ id: 'k1', secret }] })).not.toThrow();
  });

  it('accepts hex key material of the required length', () => {
    expect(() => createKeyring({ activeKeyId: 'k1', keys: [{ id: 'k1', secret: 'ab'.repeat(32) }] })).not.toThrow();
  });
});
