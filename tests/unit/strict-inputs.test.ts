import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProviderRegistry } from '@storeweave/extension-sdk';
import { noopLogger } from '@storeweave/contracts';
import { coreModules } from '@storeweave/bundle';

/**
 * Command / Query 的輸入一律拒絕未知欄位（ADR 0024）。
 *
 * 掃的是模組**註冊處**的 descriptor，不是 dto.ts 裡叫做 `*Input` 的匯出：
 * 有四個輸入 schema 是直接內嵌在 `defineQuery` / `defineCommand` 上的匿名 `z.object()`，
 * 靠命名慣例掃永遠看不到它們——第一版就是這樣漏掉的。
 */

const MODULES = coreModules({
  providers: new ProviderRegistry(noopLogger),
  defaultCurrency: 'TWD',
  orderNumberPrefix: 'SW',
  timezone: 'Asia/Taipei',
  locale: 'zh-TW',
});

/** `.refine()` 之後外面包的是 ZodEffects，要剝到裡面的 object 才看得到 unknownKeys。 */
function unwrap(schema: unknown): z.ZodTypeAny | null {
  let current = schema as z.ZodTypeAny;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof z.ZodObject) return current;
    if (current instanceof z.ZodEffects) { current = current.innerType(); continue; }
    if (current instanceof z.ZodDefault) { current = current.removeDefault(); continue; }
    if (current instanceof z.ZodOptional) { current = current.unwrap(); continue; }
    return null;
  }
  return null;
}

function registeredInputs(): [string, unknown][] {
  const found: [string, unknown][] = [];
  for (const module of MODULES) {
    for (const { descriptor } of module.commands ?? []) found.push([descriptor.name, descriptor.input]);
    for (const { descriptor } of module.queries ?? []) found.push([descriptor.name, descriptor.input]);
  }
  return found;
}

describe('所有 Command / Query 輸入都拒絕未知欄位', () => {
  it('掃得到八個模組的註冊——掃不到東西的測試會永遠是綠的', () => {
    const names = registeredInputs().map(([name]) => name);
    expect(names.length).toBeGreaterThan(50);
    for (const module of ['catalog', 'inventory', 'customer', 'cart', 'promotion', 'coupon', 'loyalty', 'order']) {
      expect(names.some((n) => n.startsWith(`commerce.${module}.`))).toBe(true);
    }
  });

  it.each(registeredInputs())('%s 的輸入是 strict', (_name, schema) => {
    const object = unwrap(schema);
    // 輸入不是 object 的話沒有「未知欄位」可言，但這個 repo 目前每一支都是 object；
    // 哪天不是了，這裡要的是一個明確的失敗而不是靜靜跳過。
    expect(object).toBeInstanceOf(z.ZodObject);
    expect((object as z.ZodObject<z.ZodRawShape>)._def.unknownKeys).toBe('strict');
  });

  it('多帶一個不認得的欄位會被擋下來，而不是安靜地忽略它', () => {
    const [, schema] = registeredInputs().find(([name]) => name === 'commerce.catalog.createProduct')!;
    const result = (schema as z.ZodTypeAny).safeParse({
      sku: 'STRICT-1', name: '嚴格', priceCents: 100, statuss: 'active',
    });
    expect(result.success).toBe(false);
  });
});
