import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { declaredInputKeys, inputObjectOf } from '../src/schema-keys';

/** HTTP 橋接挑欄位的依據（工單 51）。剝不出 object 就回 null，而不是一個空集合。 */
describe('declaredInputKeys', () => {
  it('讀得出宣告過的鍵', () => {
    expect([...declaredInputKeys(z.object({ a: z.string(), b: z.number() }).strict())!]).toEqual(['a', 'b']);
  });

  it('剝得掉 refine / default / optional 包出來的 wrapper', () => {
    const refined = z.object({ a: z.string() }).strict().refine(() => true);
    expect([...declaredInputKeys(refined)!]).toEqual(['a']);
    expect([...declaredInputKeys(z.object({ a: z.string() }).default({ a: 'x' }))!]).toEqual(['a']);
    expect([...declaredInputKeys(z.object({ a: z.string() }).optional())!]).toEqual(['a']);
  });

  it('不是 object 的輸入回 null——空集合會被誤讀成「一個鍵都不收」', () => {
    expect(declaredInputKeys(z.string())).toBeNull();
    expect(inputObjectOf(z.array(z.string()))).toBeNull();
  });
});
