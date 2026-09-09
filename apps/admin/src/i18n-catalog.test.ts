import { describe, expect, it } from 'vitest';
import { LOCALES, catalogForTest, type Locale } from './i18n';

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

function placeholdersOf(message: string): string[] {
  return [...message.matchAll(PLACEHOLDER)].map((match) => match[1]).sort();
}

describe('admin message catalog', () => {
  it('has the same keys in every locale', () => {
    const reference = Object.keys(catalogForTest['zh-TW']).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(catalogForTest[locale as Locale]).sort()).toEqual(reference);
    }
  });

  it('uses the same placeholders for a key in every locale', () => {
    // 佔位符不一致會讓同一個呼叫點在某個語系顯示 {orderId}、在另一個語系丟例外。
    const mismatched: string[] = [];
    for (const key of Object.keys(catalogForTest['zh-TW'])) {
      const expected = placeholdersOf(catalogForTest['zh-TW'][key as never]);
      for (const locale of LOCALES) {
        const actual = placeholdersOf(catalogForTest[locale as Locale][key as never]);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatched.push(`${key} (${locale})`);
      }
    }
    expect(mismatched).toEqual([]);
  });
});
