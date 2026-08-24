import { createHash, timingSafeEqual } from 'node:crypto';

export type EcpayFields = Readonly<Record<string, string>>;

/**
 * ECPay AIO's SHA-256 (EncryptType=1) checksum algorithm. Its URL encoding is
 * intentionally the .NET-compatible variant documented by ECPay, not ordinary
 * form encoding.
 */
export function createCheckMacValue(fields: EcpayFields, hashKey: string, hashIv: string): string {
  const ordered = Object.entries(fields)
    .filter(([key]) => key !== 'CheckMacValue')
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const source = `HashKey=${hashKey}&${ordered}&HashIV=${hashIv}`;
  return createHash('sha256').update(ecpayUrlEncode(source)).digest('hex').toUpperCase();
}

export function verifyCheckMacValue(fields: EcpayFields, hashKey: string, hashIv: string): boolean {
  const supplied = fields.CheckMacValue;
  if (!supplied) return false;
  const expected = createCheckMacValue(fields, hashKey, hashIv);
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(supplied.toUpperCase(), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function ecpayUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .toLowerCase()
    .replace(/%20/g, '+')
    .replace(/%2d/g, '-')
    .replace(/%5f/g, '_')
    .replace(/%2e/g, '.')
    .replace(/%21/g, '!')
    .replace(/%2a/g, '*')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')');
}
