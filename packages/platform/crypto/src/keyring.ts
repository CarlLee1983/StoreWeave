import { hkdfSync } from 'node:crypto';
import { randomToken } from './random';

/** key id 與 purpose 共用這個字集：它們會直接出現在 token 裡，不能含分隔符號。 */
const LABEL_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** 低於這個長度的 root secret 無法支撐 HMAC-SHA256 宣稱的強度。 */
const MINIMUM_SECRET_BYTES = 32;

/**
 * root secret 必須是編碼過的隨機材料，不是人打得出來的字串。字元長度不等於熵：
 * 32 個 hex 字元看起來夠長，實際只有 16 bytes；`please-change-me-please-change-me`
 * 更是剛好 32 bytes 卻幾乎沒有熵。所以只接受 base64url 或 hex，並檢查解碼後長度。
 */
function decodeSecret(id: string, secret: string): Buffer {
  const encoding = /^[0-9a-fA-F]+$/.test(secret) && secret.length % 2 === 0 ? 'hex' : 'base64url';
  const decoded = Buffer.from(secret, encoding);
  // 兩種編碼都會靜默略過不合法字元，所以用來回編碼確認整串都被吃進去。
  if (decoded.toString(encoding) !== secret) {
    throw new Error(`Signing key ${id} must be base64url- or hex-encoded random material`);
  }
  if (decoded.length < MINIMUM_SECRET_BYTES) {
    throw new Error(`Signing key ${id} must decode to at least ${MINIMUM_SECRET_BYTES} bytes of key material`);
  }
  return decoded;
}

/** 產生一把合格的 root secret。部署文件與營運工具都用這個，不要自己想一串。 */
export function generateSigningKeySecret(): string {
  return randomToken(MINIMUM_SECRET_BYTES);
}

const DERIVED_KEY_BYTES = 32;

export interface SigningKeyMaterial {
  /** 出現在已簽發值裡的識別碼。一旦發行就不能重新指派給別的秘密。 */
  readonly id: string;
  readonly secret: string;
}

export interface KeyringInput {
  readonly activeKeyId: string;
  readonly keys: readonly SigningKeyMaterial[];
}

export interface Keyring {
  /** 新簽發的值一律用這把。 */
  readonly activeKeyId: string;
  /** 目前仍可驗證的所有 key id，依設定順序。 */
  keyIds(): string[];
  has(keyId: string): boolean;
  /**
   * 由 root secret 依用途推導子金鑰。同一把 root secret 在不同 purpose 下得到
   * 互不相關的材料，所以某個用途的簽章不能拿去偽造另一個用途。
   */
  derive(purpose: string, keyId: string): Buffer;
}

function assertLabel(kind: string, value: string): void {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${kind}: expected a string, received ${typeof value}`);
  }
  if (!LABEL_PATTERN.test(value)) {
    throw new Error(`Invalid ${kind}: must match ${LABEL_PATTERN.source}`);
  }
}

export function assertPurpose(purpose: string): void {
  assertLabel('purpose', purpose);
}

export function createKeyring(input: KeyringInput): Keyring {
  if (input.keys.length === 0) {
    throw new Error('A keyring needs at least one signing key');
  }

  const secrets = new Map<string, Buffer>();
  for (const key of input.keys) {
    assertLabel('key id', key.id);
    if (secrets.has(key.id)) throw new Error(`Duplicate signing key id: ${key.id}`);
    secrets.set(key.id, decodeSecret(key.id, key.secret));
  }

  assertLabel('key id', input.activeKeyId);
  if (!secrets.has(input.activeKeyId)) {
    throw new Error(`The active signing key ${input.activeKeyId} is not configured`);
  }

  const derived = new Map<string, Buffer>();

  return {
    activeKeyId: input.activeKeyId,
    keyIds: () => [...secrets.keys()],
    has: (keyId) => secrets.has(keyId),
    derive(purpose, keyId) {
      assertPurpose(purpose);
      const secret = secrets.get(keyId);
      if (!secret) throw new Error(`Unknown signing key id: ${keyId}`);
      const cacheKey = `${keyId} ${purpose}`;
      // 交出副本：呼叫端對回傳值做 fill(0) 之類的清理，不該毀掉整個 process 的金鑰。
      const cached = derived.get(cacheKey);
      if (cached) return Buffer.from(cached);
      // info 綁住 purpose 與 key id，salt 留空：root secret 已是高熵材料。
      const info = `storeweave/v1/${keyId}/${purpose}`;
      const material = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, DERIVED_KEY_BYTES));
      derived.set(cacheKey, material);
      return Buffer.from(material);
    },
  };
}
