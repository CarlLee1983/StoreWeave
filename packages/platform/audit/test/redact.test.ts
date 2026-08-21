import { describe, expect, it } from 'vitest';
import { redact } from '@storeweave/audit';

describe('redact', () => {
  it('遮蔽疑似機密的欄位', () => {
    expect(redact({ apiKey: 'sk_live_123', name: 'x' })).toEqual({ apiKey: '[redacted]', name: 'x' });
  });

  it('遞迴處理巢狀結構', () => {
    expect(redact({ outer: { password: 'p', ok: 1 } })).toEqual({ outer: { password: '[redacted]', ok: 1 } });
  });

  it('保留非物件的值', () => {
    expect(redact('plain')).toBe('plain');
    expect(redact(null)).toBeNull();
  });
});
