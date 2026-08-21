import { describe, expect, it } from 'vitest';
import { canonicalJson, requestHash } from '@storeweave/command-bus';

describe('canonicalJson', () => {
  it('產生與鍵順序無關的字串', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('忽略 undefined 欄位', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('遞迴處理陣列與巢狀物件', () => {
    expect(canonicalJson({ list: [{ z: 1, a: 2 }] })).toBe('{"list":[{"a":2,"z":1}]}');
  });
});

describe('requestHash', () => {
  it('相同語意的請求得到相同 hash', () => {
    expect(requestHash({ sku: 'A', qty: 2 })).toBe(requestHash({ qty: 2, sku: 'A' }));
  });

  it('不同內容得到不同 hash', () => {
    expect(requestHash({ qty: 2 })).not.toBe(requestHash({ qty: 3 }));
  });
});
