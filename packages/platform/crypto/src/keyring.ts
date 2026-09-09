import { hkdfSync } from 'node:crypto';

/** key id 與 purpose 共用這個字集：它們會直接出現在 token 裡，不能含分隔符號。 */
const LABEL_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** 低於這個長度的 root secret 無法支撐 HMAC-SHA256 宣稱的強度。 */
const MINIMUM_SECRET_BYTES = 32;

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
    const secret = Buffer.from(key.secret, 'utf8');
    if (secret.length < MINIMUM_SECRET_BYTES) {
      throw new Error(`Signing key ${key.id} must be at least ${MINIMUM_SECRET_BYTES} bytes`);
    }
    secrets.set(key.id, secret);
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
      const cached = derived.get(cacheKey);
      if (cached) return cached;
      // info 綁住 purpose 與 key id，salt 留空：root secret 已是高熵材料。
      const info = `storeweave/v1/${keyId}/${purpose}`;
      const material = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, DERIVED_KEY_BYTES));
      derived.set(cacheKey, material);
      return material;
    },
  };
}
