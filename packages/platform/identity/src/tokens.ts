import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { PlatformError, type Tx } from '@storeweave/contracts';
import { decryptString, encryptString, signValue, verifySignedValue, type Keyring } from '@storeweave/crypto';

/**
 * 一張表、三種用途。密碼重設、信箱驗證與信箱變更的安全性質完全一樣——
 * 單次使用、有到期、離開行程——分成三張表只會讓三份清理與三份重放防護各自漂移。
 */
export type IdentityTokenPurpose = 'password-reset' | 'email-verification' | 'email-change';

/**
 * 每個用途一個簽章 purpose。ADR 0038 的子金鑰推導因此讓重設連結與驗證連結
 * 的金鑰材料互不相關：拿得到其中一個簽章的人構造不出另一個。
 */
const SIGNING_PURPOSE: Readonly<Record<IdentityTokenPurpose, string>> = {
  'password-reset': 'identity-password-reset',
  'email-verification': 'identity-email-verification',
  'email-change': 'identity-email-change',
};

/** 暫存的新信箱是個人資料，落地前先封裝。 */
const DATA_PURPOSE = 'identity-token-data';

/**
 * 失敗一律同一句話。分辨「簽章不對」「已經用過」「過期了」對使用者沒有幫助，
 * 對想知道某個 token 是否存在的人倒是很有幫助。
 */
export const IDENTITY_TOKEN_REJECTION = 'This link is invalid or has expired';

function rejection(): PlatformError {
  return PlatformError.validation(IDENTITY_TOKEN_REJECTION);
}

export interface IssuedIdentityToken {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface ConsumedIdentityToken {
  readonly userId: string;
  readonly data: string | null;
}

/**
 * 簽發與消費身分連結。所有方法都收 `Tx`：token 與它引發的副作用
 * （寄信、改密碼、換信箱）必須同生共死，否則會出現「信寄出去了但 token 不存在」
 * 或「token 存了但沒有人收到信」。
 */
export class IdentityTokenService {
  constructor(private readonly keyring: Keyring) {}

  /** 作廢某個帳號某個用途尚未使用的 token。「我又點了一次」不該讓上一封信繼續有效。 */
  async invalidate(tx: Tx, userId: string, purpose: IdentityTokenPurpose): Promise<void> {
    await tx.execute(sql`
      UPDATE platform_identity_tokens SET used_at = now()
      WHERE user_id = ${userId} AND purpose = ${purpose} AND used_at IS NULL
    `);
  }

  async issue(
    tx: Tx,
    input: { userId: string; purpose: IdentityTokenPurpose; ttlMs: number; data?: string },
  ): Promise<IssuedIdentityToken> {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + input.ttlMs);
    const data = input.data === undefined
      ? null
      : encryptString(this.keyring, { purpose: DATA_PURPOSE, plaintext: input.data });

    await tx.execute(sql`
      INSERT INTO platform_identity_tokens (id, user_id, purpose, data, expires_at)
      VALUES (${id}, ${input.userId}, ${input.purpose}, ${data}, ${expiresAt.toISOString()})
    `);

    // 資料庫裡沒有任何可以重建這個字串的材料：簽章的證據是金鑰，重放的證據是 used_at。
    return {
      id,
      expiresAt,
      token: signValue(this.keyring, { purpose: SIGNING_PURPOSE[input.purpose], payload: id, expiresAt }),
    };
  }

  /**
   * 驗證並一次性消費。標記 used_at 與讀出 user 是同一個 UPDATE ... RETURNING，
   * 所以兩個同時抵達的請求只有一個會拿到列——重放防護不依賴呼叫端的順序。
   */
  async consume(
    tx: Tx,
    input: { token: string; purpose: IdentityTokenPurpose },
  ): Promise<ConsumedIdentityToken> {
    const verified = verifySignedValue(this.keyring, {
      purpose: SIGNING_PURPOSE[input.purpose],
      token: input.token,
      now: new Date(),
    });
    if (!verified.ok) throw rejection();

    const result = await tx.execute<{ user_id: string; data: string | null }>(sql`
      UPDATE platform_identity_tokens SET used_at = now()
      WHERE id = ${verified.payload} AND purpose = ${input.purpose}
        AND used_at IS NULL AND expires_at > now()
      RETURNING user_id, data
    `);
    const row = result.rows[0];
    if (!row) throw rejection();

    if (row.data === null) return { userId: row.user_id, data: null };
    const opened = decryptString(this.keyring, { purpose: DATA_PURPOSE, sealed: row.data });
    // 金鑰已從設定移除，或密文被動過：兩者都不是使用者能修正的，但也都不該讓流程繼續。
    if (!opened.ok) throw rejection();
    return { userId: row.user_id, data: opened.plaintext };
  }

  /** 清掉已到期或已使用的列。過期的 token 沒有稽核價值，留著只是個人資料。 */
  async purge(tx: Tx, retainUsedFor: number): Promise<number> {
    const cutoff = new Date(Date.now() - retainUsedFor).toISOString();
    const result = await tx.execute(sql`
      DELETE FROM platform_identity_tokens
      WHERE expires_at < now() OR (used_at IS NOT NULL AND used_at < ${cutoff})
    `);
    return result.rowCount ?? 0;
  }
}
