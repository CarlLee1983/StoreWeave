import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { assertPurpose, type Keyring } from './keyring';

const VERSION = 'swe1';
const PART_COUNT = 5;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptStringInput {
  readonly purpose: string;
  readonly plaintext: string;
}

export interface DecryptStringInput {
  readonly purpose: string;
  readonly sealed: string;
}

export type DecryptFailure = 'malformed' | 'unknown_key' | 'bad_ciphertext';

export type DecryptedString =
  | { readonly ok: true; readonly plaintext: string; readonly keyId: string }
  | { readonly ok: false; readonly reason: DecryptFailure };

/** 與簽發值同樣的理由：一份密文只能有一種字串寫法。 */
function isCanonicalBase64Url(value: string): boolean {
  return Buffer.from(value, 'base64url').toString('base64url') === value;
}

/** AAD 綁住版本、金鑰與用途，換掉任何一項都會讓 GCM tag 驗不過。 */
function associatedData(keyId: string, purpose: string): Buffer {
  return Buffer.from([VERSION, keyId, purpose].join('\n'), 'utf8');
}

/**
 * 以 active key 的 purpose 子金鑰做 AES-256-GCM 封裝。
 *
 * IV 每次隨機 12 bytes。NIST SP 800-38D 對隨機 IV 的上限是每把金鑰 2^32 次加密，
 * 而子金鑰的壽命綁在 key id 上（ADR 0038：發行後不重指派）。要用在會產生數十億
 * 筆密文的場景之前，先安排該 purpose 的金鑰輪替，不要沿用同一把。
 */
export function encryptString(keyring: Keyring, input: EncryptStringInput): string {
  assertPurpose(input.purpose);
  const keyId = keyring.activeKeyId;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyring.derive(input.purpose, keyId), iv);
  cipher.setAAD(associatedData(keyId, input.purpose));
  const ciphertext = Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()]);
  return [VERSION, keyId, iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

/** 解封裝。與簽章一致：金鑰未知、內容被動過與格式錯誤分開回報。 */
export function decryptString(keyring: Keyring, input: DecryptStringInput): DecryptedString {
  assertPurpose(input.purpose);
  const parts = input.sealed.split('.');
  if (parts.length !== PART_COUNT) return { ok: false, reason: 'malformed' };
  const [version, keyId, ivRaw, ciphertextRaw, tagRaw] = parts;
  if (version !== VERSION) return { ok: false, reason: 'malformed' };
  if (![ivRaw, ciphertextRaw, tagRaw].every(isCanonicalBase64Url)) return { ok: false, reason: 'malformed' };
  if (!keyring.has(keyId)) return { ok: false, reason: 'unknown_key' };

  const iv = Buffer.from(ivRaw, 'base64url');
  const tag = Buffer.from(tagRaw, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return { ok: false, reason: 'malformed' };

  try {
    const decipher = createDecipheriv('aes-256-gcm', keyring.derive(input.purpose, keyId), iv);
    decipher.setAAD(associatedData(keyId, input.purpose));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, 'base64url')), decipher.final()]).toString('utf8');
    return { ok: true, plaintext, keyId };
  } catch {
    // GCM 驗證失敗只有一個意思：內容或 AAD 被動過。不再細分，免得變成預言機。
    return { ok: false, reason: 'bad_ciphertext' };
  }
}
