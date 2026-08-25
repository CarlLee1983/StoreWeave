import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProviderRegistry } from '@storeweave/extension-sdk';
import { inputObjectOf, noopLogger } from '@storeweave/contracts';
import { coreModules } from '@storeweave/bundle';
import { identityModule } from '@storeweave/identity';
import { createOpsModule } from '@storeweave/kernel';
import { addressDto } from '@storeweave/customer';
import { promotionRule } from '@storeweave/promotion';

/**
 * Command / Query 的輸入一律拒絕未知欄位（ADR 0024）。
 *
 * 掃的是模組**註冊處**的 descriptor，不是 dto.ts 裡叫做 `*Input` 的匯出：
 * 有四個輸入 schema 是直接內嵌在 `defineQuery` / `defineCommand` 上的匿名 `z.object()`，
 * 靠命名慣例掃永遠看不到它們——第一版就是這樣漏掉的。
 */

/** 與 `createRuntime()` 掛載的一致：ops 與 identity 也是 Command Bus 上的公民（ADR 0024）。 */
const MODULES = [
  createOpsModule({} as never),
  identityModule,
  ...coreModules({
    providers: new ProviderRegistry(noopLogger),
    defaultCurrency: 'TWD',
    orderNumberPrefix: 'SW',
    timezone: 'Asia/Taipei',
    locale: 'zh-TW',
  }),
];

function registeredInputs(): [string, unknown][] {
  const found: [string, unknown][] = [];
  for (const module of MODULES) {
    for (const { descriptor } of module.commands ?? []) found.push([descriptor.name, descriptor.input]);
    for (const { descriptor } of module.queries ?? []) found.push([descriptor.name, descriptor.input]);
  }
  return found;
}

describe('所有 Command / Query 輸入都拒絕未知欄位', () => {
  it('掃得到每一個模組的註冊——掃不到東西的測試會永遠是綠的', () => {
    const names = registeredInputs().map(([name]) => name);
    expect(names.length).toBeGreaterThan(50);
    const prefixes = [
      'commerce.catalog.', 'commerce.inventory.', 'commerce.customer.', 'commerce.cart.',
      'commerce.promotion.', 'commerce.coupon.', 'commerce.loyalty.', 'commerce.order.',
      'commerce.refund.',
      'platform.identity.', 'platform.jobs.',
    ];
    // 只斷言總數的話，少掉整個模組也看不出來。
    for (const prefix of prefixes) expect(names.some((n) => n.startsWith(prefix))).toBe(true);
  });

  it.each(registeredInputs())('%s 多帶一個不認得的欄位會被擋', (_name, schema) => {
    // 剝 wrapper 的那一段與 HTTP 橋接挑欄位時用的是同一支（`inputObjectOf`）：
    // 兩邊各寫一次，遲早會有一邊剝得出來、另一邊剝不出來。
    const object = inputObjectOf(schema);
    // 輸入不是 object 的話沒有「未知欄位」可言，但這個 repo 目前每一支都是 object；
    // 哪天不是了，這裡要的是一個明確的失敗而不是靜靜跳過。
    expect(object).toBeInstanceOf(z.ZodObject);

    // 真的解析一次，不是讀 `_def.unknownKeys`：`.strict().catchall(z.unknown())` 會讓那個欄位
    // 仍然是 'strict' 而未知鍵照樣通過。這裡要的是行為，不是宣告。
    const result = (schema as z.ZodTypeAny).safeParse({ __definitely_not_a_field__: 1 });
    expect(result.success).toBe(false);
    const codes = result.error!.issues.map((issue) => issue.code);
    expect(codes).toContain('unrecognized_keys');
  });

  it('拼錯的欄位名擋得下來，而且說得出是哪一個', () => {
    const [, schema] = registeredInputs().find(([name]) => name === 'commerce.catalog.createProduct')!;
    const result = (schema as z.ZodTypeAny).safeParse({
      sku: 'STRICT-1', name: '嚴格', priceCents: 100, statuss: 'active',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error!.issues)).toContain('statuss');
  });

  it('型錄價格界線接受 REST query 傳來的數字字串，並保留整數限制', () => {
    const [, schema] = registeredInputs().find(([name]) => name === 'commerce.catalog.searchProducts')!;
    const parsed = (schema as z.ZodTypeAny).parse({ minPriceCents: '50000', maxPriceCents: '100000' });
    expect(parsed).toMatchObject({ minPriceCents: 50_000, maxPriceCents: 100_000 });
    expect((schema as z.ZodTypeAny).safeParse({ minPriceCents: '1.5' }).success).toBe(false);
  });
});

describe('巢狀的輸入物件也拒絕未知欄位，但讀回來的路徑不變', () => {
  it('訂單品項多一個欄位會被擋，而不是安靜地丟掉', () => {
    const [, schema] = registeredInputs().find(([name]) => name === 'commerce.order.placeOrder')!;
    const result = (schema as z.ZodTypeAny).safeParse({
      lines: [{ productId: '11111111-1111-4111-8111-111111111111', quantity: 1, note: '禮盒包裝' }],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error!.issues)).toContain('note');
  });

  it('收件地址多一個欄位會被擋', () => {
    const [, schema] = registeredInputs().find(([name]) => name === 'commerce.customer.updateMyProfile')!;
    const result = (schema as z.ZodTypeAny).safeParse({
      address: {
        recipient: '王小明', phone: '0912345678', postcode: '100', city: '台北市',
        line1: '中正區重慶南路一段', country: 'TW',
      },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error!.issues)).toContain('country');
  });

  it('活動規則多一個欄位會被擋', () => {
    const [, schema] = registeredInputs().find(([name]) => name === 'commerce.promotion.createPromotion')!;
    const result = (schema as z.ZodTypeAny).safeParse({
      name: '巢狀', rule: { type: 'order_percentage', percentOffBasisPoints: 500, note: 'x' },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error!.issues)).toContain('note');
  });

  it('但既有資料讀得回來——輸出的形狀刻意維持寬鬆', () => {
    // 建立時被忽略而存進 jsonb 的多餘鍵，不該讓這檔活動從此讀不回來。
    expect(promotionRule.safeParse({ type: 'order_percentage', percentOffBasisPoints: 500, note: 'x' }).success).toBe(true);
    expect(addressDto.safeParse({
      recipient: '王小明', phone: '0912345678', postcode: '100', city: '台北市',
      line1: '中正區重慶南路一段', country: 'TW',
    }).success).toBe(true);
  });
});
