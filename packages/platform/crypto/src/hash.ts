import { createHash, createHmac } from 'node:crypto';

/** 內容摘要。不適用於密碼；密碼雜湊在 `@storeweave/identity`。 */
export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 以既有金鑰材料計算 HMAC-SHA256。金鑰通常來自 `Keyring.derive`。 */
export function hmacSha256(key: Buffer, value: string | Buffer): Buffer {
  return createHmac('sha256', key).update(value).digest();
}
