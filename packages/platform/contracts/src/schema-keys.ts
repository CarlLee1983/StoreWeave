import { z } from 'zod';

/**
 * 剝到輸入 schema 最外層的那個 object。
 *
 * `.refine()` 之後外面包的是 ZodEffects、`.default()` 包的是 ZodDefault——
 * 讀 shape 或 unknownKeys 之前都得先剝掉。認不得的 wrapper 回 null，
 * 呼叫端要的是一個明確的「看不懂」，而不是一個空的鍵集合。
 */
export function inputObjectOf(schema: unknown): z.ZodObject<z.ZodRawShape> | null {
  let current = schema as z.ZodTypeAny;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof z.ZodObject) return current as z.ZodObject<z.ZodRawShape>;
    if (current instanceof z.ZodEffects) { current = current.innerType(); continue; }
    if (current instanceof z.ZodDefault) { current = current.removeDefault(); continue; }
    if (current instanceof z.ZodOptional) { current = current.unwrap(); continue; }
    return null;
  }
  return null;
}

/**
 * 一支輸入宣告了哪些鍵。HTTP 這一層要挑欄位時的唯一依據——
 * 契約自己說得出來，橋接不必再抄一份白名單（ADR 0024）。
 */
export function declaredInputKeys(schema: unknown): ReadonlySet<string> | null {
  const object = inputObjectOf(schema);
  return object ? new Set(Object.keys(object.shape)) : null;
}
