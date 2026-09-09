import { describe, expect, it } from 'vitest';
import { createKeyring } from '../src/keyring';
import { decryptString, encryptString } from '../src/encryption';

const keys = [
  { id: 'k1', secret: '11'.repeat(32) },
  { id: 'k2', secret: '22'.repeat(32) },
];
const keyring = createKeyring({ activeKeyId: 'k1', keys });

describe('symmetric encryption', () => {
  it('round-trips a plaintext', () => {
    const sealed = encryptString(keyring, { purpose: 'provider-credential', plaintext: '中文 secret' });
    expect(decryptString(keyring, { purpose: 'provider-credential', sealed })).toEqual({ ok: true, plaintext: '中文 secret', keyId: 'k1' });
  });

  it('does not leak the plaintext into the ciphertext', () => {
    expect(encryptString(keyring, { purpose: 'provider-credential', plaintext: 'needle' })).not.toContain('needle');
  });

  it('produces a different ciphertext each time', () => {
    const a = encryptString(keyring, { purpose: 'provider-credential', plaintext: 'same' });
    const b = encryptString(keyring, { purpose: 'provider-credential', plaintext: 'same' });
    expect(a).not.toBe(b);
  });

  it('rejects a tampered ciphertext', () => {
    const [v, keyId, iv, ct, tag] = encryptString(keyring, { purpose: 'provider-credential', plaintext: 'secret' }).split('.');
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0] ^= 0xff;
    expect(decryptString(keyring, { purpose: 'provider-credential', sealed: [v, keyId, iv, flipped.toString('base64url'), tag].join('.') }))
      .toEqual({ ok: false, reason: 'bad_ciphertext' });
  });

  it('rejects a ciphertext opened under another purpose', () => {
    const sealed = encryptString(keyring, { purpose: 'provider-credential', plaintext: 'secret' });
    expect(decryptString(keyring, { purpose: 'session-payload', sealed })).toEqual({ ok: false, reason: 'bad_ciphertext' });
  });

  it('reports an unknown key id after that key is removed', () => {
    const sealed = encryptString(keyring, { purpose: 'provider-credential', plaintext: 'secret' });
    const rotated = createKeyring({ activeKeyId: 'k2', keys: [keys[1]] });
    expect(decryptString(rotated, { purpose: 'provider-credential', sealed })).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('still opens a ciphertext sealed by a retired key that is still configured', () => {
    const sealed = encryptString(createKeyring({ activeKeyId: 'k1', keys }), { purpose: 'provider-credential', plaintext: 'secret' });
    const rotated = createKeyring({ activeKeyId: 'k2', keys });
    expect(decryptString(rotated, { purpose: 'provider-credential', sealed })).toMatchObject({ ok: true, keyId: 'k1' });
  });

  it('rejects malformed input without throwing', () => {
    for (const sealed of ['', 'swe1', 'swe1.k1.a.b', 'nope.k1.a.b.c']) {
      expect(decryptString(keyring, { purpose: 'provider-credential', sealed })).toEqual({ ok: false, reason: 'malformed' });
    }
  });
});

describe('sealed values are a canonical encoding', () => {
  const sealed = () => encryptString(keyring, { purpose: 'provider-credential', plaintext: 'secret' });

  it('rejects trailing junk on any segment', () => {
    const [v, keyId, iv, ct, tag] = sealed().split('.');
    const variants = [
      [v, keyId, `${iv}=`, ct, tag],
      [v, keyId, iv, `${ct}=`, tag],
      [v, keyId, iv, ct, `${tag}=`],
    ];
    for (const parts of variants) {
      expect(decryptString(keyring, { purpose: 'provider-credential', sealed: parts.join('.') }))
        .toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('gives one sealed value exactly one spelling', () => {
    const value = sealed();
    const accepted = ['', '=', '\n'].filter((suffix) =>
      decryptString(keyring, { purpose: 'provider-credential', sealed: value + suffix }).ok);
    expect(accepted).toEqual(['']);
  });
});
