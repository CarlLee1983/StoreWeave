import { describe, expect, it } from 'vitest';
import { constantTimeEquals } from '../src/constant-time';
import { randomToken } from '../src/random';
import { sha256Hex, hmacSha256 } from '../src/hash';

describe('constantTimeEquals', () => {
  it('matches identical strings and rejects different ones', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
  });

  it('rejects different lengths without throwing', () => {
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals('', 'a')).toBe(false);
  });

  it('treats two empty strings as equal', () => {
    expect(constantTimeEquals('', '')).toBe(true);
  });

  it('compares by bytes, not code units', () => {
    expect(constantTimeEquals('中', '中')).toBe(true);
    expect(constantTimeEquals('中', '文')).toBe(false);
  });
});

describe('randomToken', () => {
  it('produces url-safe tokens of the requested entropy', () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 64 }, () => randomToken(16)));
    expect(seen.size).toBe(64);
  });

  it('refuses too little entropy to be a credential', () => {
    expect(() => randomToken(8)).toThrow(/16/);
  });
});

describe('hash helpers', () => {
  it('hashes to the documented sha256 vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('produces a stable hmac and differs by key', () => {
    const a = hmacSha256(Buffer.from('key-one'), 'message');
    expect(a.equals(hmacSha256(Buffer.from('key-one'), 'message'))).toBe(true);
    expect(a.equals(hmacSha256(Buffer.from('key-two'), 'message'))).toBe(false);
  });
});

describe('constantTimeEquals as a credential comparison', () => {
  it('rejects a prefix of the expected value', () => {
    expect(constantTimeEquals('token-abcdef', 'token-abc')).toBe(false);
  });

  it('rejects an expected value that is a prefix of the presented one', () => {
    expect(constantTimeEquals('token-abc', 'token-abcdef')).toBe(false);
  });
});
