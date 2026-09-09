import { describe, expect, it } from 'vitest';
import { formatMessage, pluralize, resolveMessage } from '../src/message';

describe('formatMessage', () => {
  it('substitutes a placeholder', () => {
    expect(formatMessage('Page {page} of {total}', { page: 2, total: 9 })).toBe('Page 2 of 9');
  });

  it('substitutes every occurrence, not just the first', () => {
    expect(formatMessage('{a} and {a} again', { a: 'x' })).toBe('x and x again');
  });

  it('does not rescan a substituted value', () => {
    // 使用者輸入的商品名稱長得像 placeholder 時，不能被當成下一輪的樣板。
    expect(formatMessage('{name} costs {price}', { name: '{price}', price: 'NT$1' })).toBe('{price} costs NT$1');
  });

  it('formats numbers without locale grouping, because the caller decides that', () => {
    expect(formatMessage('{count}', { count: 1000 })).toBe('1000');
  });

  it('fails loudly on a placeholder with no value', () => {
    expect(() => formatMessage('Page {page} of {total}', { page: 1 })).toThrow(/total/);
  });

  it('fails loudly on a value with no placeholder, because it means the key changed', () => {
    expect(() => formatMessage('Page {page}', { page: 1, total: 9 })).toThrow(/total/);
  });

  it('leaves a template with no placeholders alone', () => {
    expect(formatMessage('Nothing to fill')).toBe('Nothing to fill');
  });

  it('does not treat unbalanced braces as a placeholder', () => {
    expect(formatMessage('100% of { and }')).toBe('100% of { and }');
  });
});

describe('pluralize', () => {
  it('selects the English plural forms', () => {
    expect(pluralize('en-US', 1, { one: '{count} item', other: '{count} items' })).toBe('1 item');
    expect(pluralize('en-US', 3, { one: '{count} item', other: '{count} items' })).toBe('3 items');
    expect(pluralize('en-US', 0, { one: '{count} item', other: '{count} items' })).toBe('0 items');
  });

  it('uses the single form for languages without a plural distinction', () => {
    for (const locale of ['zh-TW', 'ja-JP']) {
      expect(pluralize(locale, 1, { other: '{count} 件' })).toBe('1 件');
      expect(pluralize(locale, 7, { other: '{count} 件' })).toBe('7 件');
    }
  });

  it('falls back to other when the exact category is not supplied', () => {
    expect(pluralize('en-US', 1, { other: '{count} items' })).toBe('1 items');
  });

  it('passes extra parameters through to the selected form', () => {
    expect(pluralize('en-US', 2, { one: '{count} of {total}', other: '{count} of {total}' }, { total: 9 })).toBe('2 of 9');
  });

  it('rejects a count that is not a real number rather than rendering NaN', () => {
    expect(() => pluralize('en-US', Number.NaN, { other: '{count}' })).toThrow(/count/i);
  });

  it('falls back to the other form when the locale tag is unusable', () => {
    expect(pluralize('not a locale', 2, { one: 'one', other: 'many' })).toBe('many');
  });
});

describe('resolveMessage', () => {
  const catalogs = {
    'zh-TW': { hello: '你好', onlyChinese: '只有中文' },
    'en-US': { hello: 'Hello' },
  };

  it('reads the requested locale', () => {
    expect(resolveMessage(catalogs, ['en-US', 'zh-TW'], 'hello')).toBe('Hello');
  });

  it('walks the fallback chain when the key is missing', () => {
    expect(resolveMessage(catalogs, ['en-US', 'zh-TW'], 'onlyChinese')).toBe('只有中文');
  });

  it('skips a locale that has no catalog at all', () => {
    expect(resolveMessage(catalogs, ['ja-JP', 'zh-TW'], 'hello')).toBe('你好');
  });

  it('returns undefined when no locale in the chain has the key', () => {
    expect(resolveMessage(catalogs, ['en-US', 'zh-TW'], 'missing')).toBeUndefined();
  });

  it('does not fall through to inherited object properties', () => {
    expect(resolveMessage(catalogs, ['en-US'], 'toString')).toBeUndefined();
    expect(resolveMessage(catalogs, ['en-US'], '__proto__')).toBeUndefined();
  });
});
