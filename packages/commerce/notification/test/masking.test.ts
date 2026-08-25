import { describe, expect, it } from 'vitest';
import { maskEmailsIn, maskRecipient } from '../src/queries';

/** 工單 73 的遮蔽是一道安全控制，不是排版。 */

describe('maskRecipient', () => {
  it('留下首字與網域，星號數量固定不洩漏長度', () => {
    expect(maskRecipient('buyer@example.com')).toBe('b***@example.com');
    expect(maskRecipient('a-much-longer-address@example.com')).toBe('a***@example.com');
  });

  it('單字元本地端整個遮掉：只有一個字元時留首字等於沒遮', () => {
    expect(maskRecipient('a@example.com')).toBe('***@example.com');
  });

  it('plus-addressing 一起遮，不把 tag 留在外面', () => {
    expect(maskRecipient('carl+shop@example.com')).toBe('c***@example.com');
  });

  it('本地端是 astral 字元時不切出孤立的 surrogate', () => {
    const masked = maskRecipient('😀smith@example.com');
    expect(masked).toBe('😀***@example.com');
    // 首字是完整的一個 code point，不是被切一半的 surrogate。
    expect([...masked][0]).toBe('😀');
  });

  it('沒有 @ 或本地端為空時整個遮掉，不回傳原值', () => {
    expect(maskRecipient('not-an-address')).toBe('***');
    expect(maskRecipient('@example.com')).toBe('***');
  });
});

describe('maskEmailsIn', () => {
  it('退信訊息裡的地址也要遮：隔壁欄位遮了這裡不遮等於沒遮', () => {
    expect(maskEmailsIn('550 5.1.1 <buyer@example.com> user unknown'))
      .toBe('550 5.1.1 <b***@example.com> user unknown');
  });

  it('一則訊息裡有多個地址時全部遮掉', () => {
    expect(maskEmailsIn('from alice@a.test to bob@b.test failed'))
      .toBe('from a***@a.test to b***@b.test failed');
  });

  it('沒有地址的訊息原樣留著，null 保持 null', () => {
    expect(maskEmailsIn('SMTP timeout after 30s')).toBe('SMTP timeout after 30s');
    expect(maskEmailsIn(null)).toBeNull();
  });
});
