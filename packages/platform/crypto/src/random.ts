import { randomBytes } from 'node:crypto';

/** 低於這個位元組數就不該當成憑證使用。 */
const MINIMUM_CREDENTIAL_BYTES = 16;

/**
 * 產生 base64url 編碼的隨機憑證。回傳值可直接放進 URL、cookie 與 header，
 * 不需要再編碼一次。
 */
export function randomToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < MINIMUM_CREDENTIAL_BYTES) {
    throw new Error(`Random credentials require at least ${MINIMUM_CREDENTIAL_BYTES} bytes of entropy`);
  }
  return randomBytes(bytes).toString('base64url');
}
