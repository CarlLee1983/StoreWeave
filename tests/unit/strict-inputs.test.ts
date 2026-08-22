import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as cart from '@storeweave/cart';
import * as catalog from '@storeweave/catalog';
import * as coupon from '@storeweave/coupon';
import * as customer from '@storeweave/customer';
import * as inventory from '@storeweave/inventory';
import * as loyalty from '@storeweave/loyalty';
import * as order from '@storeweave/order';
import * as promotion from '@storeweave/promotion';

/**
 * Command / Query 的輸入一律拒絕未知欄位（ADR 0024）。
 *
 * 逐個模組寫一條「送多餘欄位會被擋」只驗得到寫測試那天想得到的 schema；
 * 這裡改成掃過所有匯出的 `*Input`，新加的 input 忘記 `.strict()` 也會被抓到。
 */

const MODULES: Record<string, Record<string, unknown>> = {
  cart, catalog, coupon, customer, inventory, loyalty, order, promotion,
};

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

function inputSchemas(): [string, z.ZodObject<z.ZodRawShape>][] {
  const found: [string, z.ZodObject<z.ZodRawShape>][] = [];
  for (const [moduleName, exported] of Object.entries(MODULES)) {
    for (const [name, value] of Object.entries(exported)) {
      if (!name.endsWith('Input')) continue;
      const object = unwrap(value);
      if (object instanceof z.ZodObject) found.push([`${moduleName}.${name}`, object]);
    }
  }
  return found;
}

describe('所有 Command / Query 輸入都拒絕未知欄位', () => {
  it('找得到夠多的 input schema——掃不到東西的測試會永遠是綠的', () => {
    expect(inputSchemas().length).toBeGreaterThan(40);
  });

  it.each(inputSchemas())('%s 是 strict', (_name, schema) => {
    expect(schema._def.unknownKeys).toBe('strict');
  });

  it('多帶一個不認得的欄位會被擋下來，而不是安靜地忽略它', () => {
    const result = catalog.createProductInput.safeParse({
      sku: 'STRICT-1', name: '嚴格', priceCents: 100, statuss: 'active',
    });
    expect(result.success).toBe(false);
  });
});
