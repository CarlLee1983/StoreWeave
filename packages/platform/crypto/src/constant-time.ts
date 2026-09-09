import { timingSafeEqual } from 'node:crypto';

/**
 * 以位元組比對兩個字串，長度不同直接回 false。
 *
 * `timingSafeEqual` 對長度不同的 buffer 會丟例外，所以長度必須先擋。長度本身會
 * 洩漏，但憑證長度在本系統是公開常數（token、簽章都定長），洩漏的是已知資訊。
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  if (bufferA.length === 0) return true;
  return timingSafeEqual(bufferA, bufferB);
}
