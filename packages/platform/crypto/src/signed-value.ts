import { assertPurpose, isValidKeyId, type Keyring } from './keyring';
import { hmacSha256 } from './hash';
import { timingSafeEqual } from 'node:crypto';

const VERSION = 'sw1';
const PART_COUNT = 5;

export interface SignValueInput {
  /** 用途標籤。驗證端必須提供同一個值，否則簽章對不上。 */
  readonly purpose: string;
  readonly payload: string;
  /** 到期時刻，秒級精度。到期當下即視為過期。 */
  readonly expiresAt: Date;
}

export interface VerifySignedValueInput {
  readonly purpose: string;
  readonly token: string;
  readonly now: Date;
}

export type SignedValueFailure = 'malformed' | 'unknown_key' | 'bad_signature' | 'expired';

export type VerifiedSignedValue =
  | { readonly ok: true; readonly payload: string; readonly keyId: string; readonly expiresAt: Date }
  | { readonly ok: false; readonly reason: SignedValueFailure };

/**
 * base64url 解碼會靜默略過字母表以外的字元，所以 `token + '='` 解出同一組位元組。
 * 若不擋，同一份授權就有無限多種字串寫法，任何以 token 字串記帳的下游——一次性
 * 重設連結的已使用表、下載 nonce 撤銷清單、replay 快取——都能被加個尾料繞過。
 */
function isCanonicalBase64Url(value: string): boolean {
  return Buffer.from(value, 'base64url').toString('base64url') === value;
}

/** 同理：`0123` 與 `123` 數值相同，但只有一種寫法算數。 */
function isCanonicalInteger(value: string): boolean {
  return /^-?\d+$/.test(value) && String(Number(value)) === value;
}

/**
 * MAC 的輸入。每一段都已限定字集或經 base64url 編碼，換行不可能出現在段落內，
 * 所以不同欄位組合不會產生同一個字串。
 */
function canonical(purpose: string, keyId: string, expiresAtSeconds: number, encodedPayload: string): string {
  return [VERSION, purpose, keyId, String(expiresAtSeconds), encodedPayload].join('\n');
}

/** 以目前的 active key 簽發一個帶到期時間的值。 */
export function signValue(keyring: Keyring, input: SignValueInput): string {
  assertPurpose(input.purpose);
  const expiresAtSeconds = Math.floor(input.expiresAt.getTime() / 1000);
  if (!Number.isFinite(expiresAtSeconds)) {
    throw new Error('Signed values require a valid expiry');
  }
  const keyId = keyring.activeKeyId;
  const encodedPayload = Buffer.from(input.payload, 'utf8').toString('base64url');
  const mac = hmacSha256(keyring.derive(input.purpose, keyId), canonical(input.purpose, keyId, expiresAtSeconds, encodedPayload));
  return [VERSION, keyId, String(expiresAtSeconds), encodedPayload, mac.toString('base64url')].join('.');
}

/**
 * 驗證簽發值。失敗原因分開回報，讓呼叫端能區分「金鑰已退場」「被竄改」與
 * 「單純過期」——三者的處置不同。順序固定為格式、金鑰、簽章、到期：先確認
 * 簽章成立才看到期時間，過期訊息才不會變成偽造 token 的預言機。
 */
export function verifySignedValue(keyring: Keyring, input: VerifySignedValueInput): VerifiedSignedValue {
  assertPurpose(input.purpose);
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new Error('Signed value verification requires a valid clock');
  }
  const parts = input.token.split('.');
  if (parts.length !== PART_COUNT) return { ok: false, reason: 'malformed' };
  const [version, keyId, expiresAtRaw, encodedPayload, presentedMac] = parts;
  if (version !== VERSION) return { ok: false, reason: 'malformed' };
  if (!isValidKeyId(keyId)) return { ok: false, reason: 'malformed' };
  if (!isCanonicalInteger(expiresAtRaw)) return { ok: false, reason: 'malformed' };
  if (!isCanonicalBase64Url(encodedPayload) || !isCanonicalBase64Url(presentedMac)) {
    return { ok: false, reason: 'malformed' };
  }
  if (!keyring.has(keyId)) return { ok: false, reason: 'unknown_key' };

  const expiresAtSeconds = Number(expiresAtRaw);
  const expected = hmacSha256(keyring.derive(input.purpose, keyId), canonical(input.purpose, keyId, expiresAtSeconds, encodedPayload));
  const presented = Buffer.from(presentedMac, 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  if (input.now.getTime() >= expiresAtSeconds * 1000) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    payload: Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    keyId,
    expiresAt: new Date(expiresAtSeconds * 1000),
  };
}
