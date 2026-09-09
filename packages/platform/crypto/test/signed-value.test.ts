import { describe, expect, it } from 'vitest';
import { createKeyring } from '../src/keyring';
import { signValue, verifySignedValue } from '../src/signed-value';

const keys = [
  { id: 'k1', secret: 'secret-one-secret-one-secret-one' },
  { id: 'k2', secret: 'secret-two-secret-two-secret-two' },
];
const keyring = createKeyring({ activeKeyId: 'k1', keys });
const expiresAt = new Date('2026-09-09T12:00:00.000Z');
const before = new Date('2026-09-09T11:59:59.000Z');
const after = new Date('2026-09-09T12:00:01.000Z');

function sign(payload = 'media/42.png', purpose = 'storage-download', ring = keyring): string {
  return signValue(ring, { purpose, payload, expiresAt });
}

describe('signed values', () => {
  it('round-trips a payload that was signed with the active key', () => {
    const token = sign();
    expect(verifySignedValue(keyring, { purpose: 'storage-download', token, now: before }))
      .toEqual({ ok: true, payload: 'media/42.png', keyId: 'k1', expiresAt });
  });

  it('carries the key id that signed it', () => {
    expect(sign().split('.')[1]).toBe('k1');
  });

  it('survives payloads with delimiters and non-ASCII text', () => {
    const payload = 'a.b.c\nd/e+f 中文';
    const token = signValue(keyring, { purpose: 'storage-download', payload, expiresAt });
    const result = verifySignedValue(keyring, { purpose: 'storage-download', token, now: before });
    expect(result).toMatchObject({ ok: true, payload });
  });

  it('rejects a tampered payload', () => {
    const [version, keyId, exp, payload, mac] = sign().split('.');
    const tampered = [version, keyId, exp, Buffer.from('media/99.png').toString('base64url'), mac].join('.');
    expect(verifySignedValue(keyring, { purpose: 'storage-download', token: tampered, now: before }))
      .toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered expiry', () => {
    const [version, keyId, exp, payload, mac] = sign().split('.');
    const extended = [version, keyId, String(Number(exp) + 86_400), payload, mac].join('.');
    expect(verifySignedValue(keyring, { purpose: 'storage-download', token: extended, now: after }))
      .toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a value signed for another purpose', () => {
    const token = sign('media/42.png', 'password-reset');
    expect(verifySignedValue(keyring, { purpose: 'storage-download', token, now: before }))
      .toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('reports expiry separately from a bad signature', () => {
    expect(verifySignedValue(keyring, { purpose: 'storage-download', token: sign(), now: after }))
      .toEqual({ ok: false, reason: 'expired' });
  });

  it('treats the expiry instant itself as expired', () => {
    expect(verifySignedValue(keyring, { purpose: 'storage-download', token: sign(), now: expiresAt }))
      .toEqual({ ok: false, reason: 'expired' });
  });

  it('reports an unknown key id without leaking whether the signature was valid', () => {
    const token = sign();
    const retired = createKeyring({ activeKeyId: 'k2', keys: [keys[1]] });
    expect(verifySignedValue(retired, { purpose: 'storage-download', token, now: before }))
      .toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('rejects malformed tokens without throwing', () => {
    for (const token of ['', 'sw1', 'sw1.k1.1.2', 'sw1.k1.1.2.3.4', 'xx1.k1.0.cGF5.bWFj', 'sw1.k1.notanumber.cGF5.bWFj']) {
      expect(verifySignedValue(keyring, { purpose: 'storage-download', token, now: before }))
        .toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('keeps verifying values signed by a retired key after rotation', () => {
    const oldToken = signValue(createKeyring({ activeKeyId: 'k1', keys }), { purpose: 'storage-download', payload: 'media/42.png', expiresAt });
    const rotated = createKeyring({ activeKeyId: 'k2', keys });
    expect(signValue(rotated, { purpose: 'storage-download', payload: 'x', expiresAt }).split('.')[1]).toBe('k2');
    expect(verifySignedValue(rotated, { purpose: 'storage-download', token: oldToken, now: before }))
      .toMatchObject({ ok: true, keyId: 'k1' });
  });

  it('refuses to sign without an expiry in the future of the caller-supplied clock', () => {
    expect(() => signValue(keyring, { purpose: 'storage-download', payload: 'x', expiresAt: new Date('invalid') }))
      .toThrow(/expiry/i);
  });
});
