const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * 填入 `{name}` 佔位符。
 *
 * 一次掃描完成，代入的值不會再被當成樣板——否則名字裡剛好有 `{price}` 的商品
 * 就會在下一輪被替換掉。缺參數與多參數都直接丟例外：兩者都代表字典與呼叫端
 * 已經對不上，讓它在測試裡炸掉，比把 `{total}` 顯示給客戶好。
 */
export function formatMessage(template: string, params: MessageParams = {}): string {
  const used = new Set<string>();
  const missing: string[] = [];

  const output = template.replace(PLACEHOLDER, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      missing.push(name);
      return match;
    }
    used.add(name);
    return String(params[name]);
  });

  if (missing.length > 0) {
    throw new Error(`Message is missing values for: ${[...new Set(missing)].sort().join(', ')}`);
  }
  const unused = Object.keys(params).filter((name) => !used.has(name));
  if (unused.length > 0) {
    throw new Error(`Message has no placeholder for: ${unused.sort().join(', ')}`);
  }
  return output;
}

export type PluralForms = Readonly<Partial<Record<Intl.LDMLPluralRule, string>>> & { readonly other: string };

/**
 * 依語言的複數規則選一個樣板。zh-TW 與 ja-JP 只有 `other`，en-US 有 `one`／`other`；
 * 這三個語系都由 Intl.PluralRules 直接覆蓋，不需要額外的訊息格式套件。
 */
export function pluralize(locale: string, count: number, forms: PluralForms, params: MessageParams = {}): string {
  if (!Number.isFinite(count)) throw new Error('A plural count must be a finite number');
  let category: Intl.LDMLPluralRule = 'other';
  try {
    category = new Intl.PluralRules(locale).select(count);
  } catch {
    // 語言標籤不合法時退回 other，而不是讓一句文案炸掉整個頁面。
  }
  const template = forms[category] ?? forms.other;
  // count 一律可用，但複數形不一定會寫出來（例如 one/many 這種純詞形），
  // 所以只有樣板真的引用時才傳進去，免得撞上「多餘參數」的檢查。
  const withCount = /\{count\}/.test(template) ? { count, ...params } : params;
  return formatMessage(template, withCount);
}

/**
 * 依 locale 順序找出第一個有這個 key 的字典。整個 chain 都沒有時回 undefined，
 * 由呼叫端決定要顯示 key 本身還是視為錯誤。
 */
export function resolveMessage(
  catalogs: Readonly<Record<string, Readonly<Record<string, string>>>>,
  locales: readonly string[],
  key: string,
): string | undefined {
  for (const locale of locales) {
    const catalog = catalogs[locale];
    // 只認字典自己的欄位：否則 `toString` 這種 key 會拿到 Object.prototype 的成員。
    if (catalog && Object.prototype.hasOwnProperty.call(catalog, key)) return catalog[key];
  }
  return undefined;
}
