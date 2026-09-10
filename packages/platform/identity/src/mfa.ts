import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { PlatformError, type DrizzleDb, type Tx } from '@storeweave/contracts';
import { decryptString, encryptString, type Keyring } from '@storeweave/crypto';

/**
 * 高權限帳號的第二因素。TOTP 的實作用 otplib，不自己算 HMAC——
 * spec 0009 明說這裡要用成熟實作，自製密碼學是這個功能唯一不能接受的做法。
 */
const MFA_SECRET_PURPOSE = 'identity-mfa-secret';

/** 授權器之間的時鐘會差幾秒。一步的容忍度是通用做法；再寬就等於延長一次可用窗口。 */
const EPOCH_TOLERANCE_SECONDS = 30;

const RECOVERY_CODE_COUNT = 10;
/**
 * 復原碼用 base32 的字母表寫成，因為它要被人抄在紙上：沒有 0/O、1/I 這種抄錯的對子，
 * 也不必區分大小寫。20 個字元就是 100 bit——熵來自這裡，不是來自產生了幾個 byte。
 */
const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const RECOVERY_CODE_LENGTH = 20;

export interface MfaEnrolment {
  /** 只在註冊當下回傳，之後系統只認得密文。 */
  readonly secret: string;
  readonly uri: string;
}

export interface MfaStatus {
  readonly enrolled: boolean;
  readonly confirmed: boolean;
  readonly recoveryCodesRemaining: number;
}

interface MfaRow extends Record<string, unknown> {
  user_id: string; secret: string; confirmed_at: Date | null; last_time_step: string | null;
}

/**
 * 復原碼是 100 bit 的隨機值，不是密碼，所以用 sha256 而不是 scrypt：
 * 沒有可猜的結構就沒有離線暴力破解的對象，而慢雜湊會讓「試十個碼」變成一秒。
 */
function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.replace(/\s|-/g, '').toUpperCase()).digest('hex');
}

/** 從字母表均勻取樣：取模會讓前幾個字元機率偏高，那是白送出去的熵。 */
function randomRecoveryCode(): string {
  const size = RECOVERY_CODE_ALPHABET.length;
  const limit = Math.floor(256 / size) * size;
  let body = '';
  while (body.length < RECOVERY_CODE_LENGTH) {
    for (const byte of randomBytes(RECOVERY_CODE_LENGTH)) {
      if (byte >= limit) continue;
      body += RECOVERY_CODE_ALPHABET[byte % size];
      if (body.length === RECOVERY_CODE_LENGTH) break;
    }
  }
  return body.replace(/(.{5})(?=.)/g, '$1-');
}

export class MfaService {
  constructor(private readonly keyring: Keyring, private readonly issuer: string) {}

  async statusFor(db: DrizzleDb | Tx, userId: string): Promise<MfaStatus> {
    const rows = await db.execute<MfaRow>(sql`SELECT * FROM platform_user_mfa WHERE user_id = ${userId}`);
    const row = rows.rows[0];
    const remaining = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM platform_mfa_recovery_codes WHERE user_id = ${userId} AND used_at IS NULL
    `);
    return {
      enrolled: Boolean(row),
      confirmed: Boolean(row?.confirmed_at),
      recoveryCodesRemaining: remaining.rows[0]?.n ?? 0,
    };
  }

  /**
   * 開始註冊。未確認之前不生效——先寫入卻沒確認的秘密如果就開始擋登入，
   * 掃描失敗的人會把自己鎖在外面。
   */
  async beginEnrolment(tx: Tx, input: { userId: string; accountName: string }): Promise<MfaEnrolment> {
    const confirmed = await tx.execute<{ confirmed_at: Date | null }>(sql`
      SELECT confirmed_at FROM platform_user_mfa WHERE user_id = ${input.userId}
    `);
    if (confirmed.rows[0]?.confirmed_at) {
      throw PlatformError.conflict('Multi-factor authentication is already enabled for this account');
    }

    const secret = generateSecret();
    const sealed = encryptString(this.keyring, { purpose: MFA_SECRET_PURPOSE, plaintext: secret });
    await tx.execute(sql`
      INSERT INTO platform_user_mfa (user_id, secret, confirmed_at, last_time_step)
      VALUES (${input.userId}, ${sealed}, NULL, NULL)
      ON CONFLICT (user_id) DO UPDATE SET secret = ${sealed}, confirmed_at = NULL, last_time_step = NULL
    `);
    return { secret, uri: generateURI({ secret, label: input.accountName, issuer: this.issuer }) };
  }

  /** 確認註冊，並一次發完復原碼。之後系統只留雜湊，補發只能整批換新。 */
  async confirmEnrolment(tx: Tx, input: { userId: string; code: string }): Promise<readonly string[]> {
    const rows = await tx.execute<MfaRow>(sql`
      SELECT * FROM platform_user_mfa WHERE user_id = ${input.userId} FOR UPDATE
    `);
    const row = rows.rows[0];
    if (!row) throw PlatformError.validation('Start multi-factor enrolment before confirming it');

    const result = this.verifyCode(row, input.code);
    if (!result.valid) throw PlatformError.validation('That code is not valid');

    await tx.execute(sql`
      UPDATE platform_user_mfa SET confirmed_at = now(), last_time_step = ${result.timeStep}
      WHERE user_id = ${input.userId}
    `);
    return this.replaceRecoveryCodes(tx, input.userId);
  }

  async replaceRecoveryCodes(tx: Tx, userId: string): Promise<readonly string[]> {
    await tx.execute(sql`DELETE FROM platform_mfa_recovery_codes WHERE user_id = ${userId}`);
    const codes: string[] = [];
    for (let index = 0; index < RECOVERY_CODE_COUNT; index += 1) {
      const code = randomRecoveryCode();
      codes.push(code);
      await tx.execute(sql`
        INSERT INTO platform_mfa_recovery_codes (id, user_id, code_hash)
        VALUES (${randomUUID()}, ${userId}, ${hashRecoveryCode(code)})
      `);
    }
    return codes;
  }

  /**
   * 登入時的第二因素。用過的時間步會被記下來，所以同一個六位數在它的窗口內
   * 只能用一次——看得到螢幕的人沒辦法在使用者按下登入之後重放同一組數字。
   */
  async verifyForLogin(
    db: DrizzleDb,
    input: { userId: string; code?: string; recoveryCode?: string },
  ): Promise<boolean> {
    if (input.recoveryCode) return this.consumeRecoveryCode(db, input.userId, input.recoveryCode);
    if (!input.code) return false;

    const rows = await db.execute<MfaRow>(sql`
      SELECT * FROM platform_user_mfa WHERE user_id = ${input.userId} AND confirmed_at IS NOT NULL
    `);
    const row = rows.rows[0];
    if (!row) return false;

    const result = this.verifyCode(row, input.code);
    if (!result.valid) return false;

    // 條件寫在 UPDATE 裡：兩個同時抵達的請求只有一個會更新到，另一個不算通過。
    const claimed = await db.execute<{ user_id: string }>(sql`
      UPDATE platform_user_mfa SET last_time_step = ${result.timeStep}
      WHERE user_id = ${input.userId}
        AND (last_time_step IS NULL OR last_time_step < ${result.timeStep})
      RETURNING user_id
    `);
    return Boolean(claimed.rows[0]);
  }

  private async consumeRecoveryCode(db: DrizzleDb, userId: string, code: string): Promise<boolean> {
    const claimed = await db.execute<{ id: string }>(sql`
      UPDATE platform_mfa_recovery_codes SET used_at = now()
      WHERE user_id = ${userId} AND used_at IS NULL AND code_hash = ${hashRecoveryCode(code)}
      RETURNING id
    `);
    return Boolean(claimed.rows[0]);
  }

  /** 關閉第二因素。呼叫端負責先驗過密碼與一組有效代碼。 */
  async disable(tx: Tx, userId: string): Promise<void> {
    await tx.execute(sql`DELETE FROM platform_mfa_recovery_codes WHERE user_id = ${userId}`);
    await tx.execute(sql`DELETE FROM platform_user_mfa WHERE user_id = ${userId}`);
  }

  private verifyCode(row: MfaRow, code: string): { valid: boolean; timeStep?: number } {
    const opened = decryptString(this.keyring, { purpose: MFA_SECRET_PURPOSE, sealed: row.secret });
    // 金鑰被移除或密文被動過：兩者都不是「代碼錯了」，但對登入端是同一個結果。
    if (!opened.ok) return { valid: false };

    const normalized = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(normalized)) return { valid: false };

    // 註記型別而不是斷言：HOTP 的結果沒有 timeStep，選用屬性正好表達「這一種沒有」。
    const verified: { valid: boolean; timeStep?: number } = verifySync({
      secret: opened.plaintext,
      token: normalized,
      strategy: 'totp',
      epochTolerance: EPOCH_TOLERANCE_SECONDS,
      ...(row.last_time_step ? { afterTimeStep: Number(row.last_time_step) } : {}),
    });
    return verified.valid ? { valid: true, timeStep: verified.timeStep } : { valid: false };
  }
}
