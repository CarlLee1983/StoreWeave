import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { PlatformError, type Actor, type DrizzleDb, type Tx } from '@storeweave/contracts';
import { COMMERCE_ROLES, roleFor, type ReleaseRoleCatalog } from '@storeweave/authorization';
// 型別 only：identity 不在執行期匯入 mail，寄信的實例由 kernel 綁進來。
import type { MailSendRequest, MailTemplate } from '@storeweave/mail';
import { accountService } from './account-service';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password';
import { UserRepository, toUserDto, type UserDto } from './repository';
import { IDENTITY_TOKEN_REJECTION, type IdentityTokenService } from './tokens';
import type { MfaService } from './mfa';
import { EMAIL_CHANGE_TEMPLATE, EMAIL_VERIFICATION_TEMPLATE, PASSWORD_RESET_TEMPLATE } from './mail-templates';

export interface IssuedSession {
  token: string;
  expiresAt: Date;
  user: UserDto;
  /** 角色要求第二因素，但這個帳號還沒完成註冊。UI 應該把人帶去設定流程。 */
  mfaEnrolmentRequired?: boolean;
}

export interface ResolvedSession {
  actor: Actor;
  user: UserDto;
}

/**
 * 密碼長度下限依角色而異：後台帳號改得了設定、看得到所有訂單，門檻高一點；
 * 前台會員以長度優先、不強制大小寫與符號（複雜度規則只會逼出可預測的變形）。
 */
export function minPasswordLengthFor(role: string, roles: ReleaseRoleCatalog = COMMERCE_ROLES): number {
  const account = roleFor(roles, role)?.account;
  if (!account) throw PlatformError.validation(`Unknown account role "${role}"`);
  return account.minPasswordLength;
}

function assertPasswordLength(password: string, role: string, roles: ReleaseRoleCatalog): void {
  const min = minPasswordLengthFor(role, roles);
  if (password.length < min) {
    throw new PlatformError('VALIDATION_ERROR', `Password must be at least ${min} characters`);
  }
}

/** 顧客帳號的角色名。identity 只認得「這是一個角色」，顧客的領域資料在 commerce/customer。 */
export const CUSTOMER_ROLE = 'customer';

/** 認證失敗一律用同一句話：區分「沒這個帳號」與「密碼錯」等於送出帳號枚舉管道。 */
const FAILED = 'Invalid email or password';

/**
 * 第二因素是登入的另一段，不是另一種失敗。訊息必須說得出「還差一步」，
 * 否則使用者只會一直重打密碼。密碼已經對了才會走到這裡。
 */
export const MFA_REQUIRED = 'A multi-factor code is required';

/**
 * 連續失敗到這個次數就暫時鎖住這個帳號。限流擋的是「一個來源打很多次」，
 * 鎖定擋的是「很多來源打同一個帳號」——兩者擋的不是同一種攻擊。
 */
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MS = 15 * 60_000;

const DEFAULT_RESET_TTL_MS = 60 * 60_000;
const OPERATOR_RESET_TTL_MS = 15 * 60_000;
const DEFAULT_VERIFICATION_TTL_MS = 24 * 60 * 60_000;

/** identity 只需要「在這個交易裡排一封信」，不需要 mail 的其餘介面。 */
export interface IdentityMailer {
  queue(tx: Tx, request: MailSendRequest): Promise<unknown>;
}

export interface IdentityTransactor {
  readonly db: DrizzleDb;
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface IdentityServiceOptions {
  readonly database: IdentityTransactor;
  readonly tokens: IdentityTokenService;
  readonly mfa: MfaService;
  readonly mail: IdentityMailer;
  /** 連結的來源；信裡的網址只由設定決定，不由請求的 Host 決定。 */
  readonly publicUrl: string;
  readonly storeName: string;
  readonly locale: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * CSRF token 由 session token 推導，而不是各自獨立的隨機值。
 * 獨立隨機值只要求「header 等於 cookie」，能對父網域寫 cookie 的攻擊者
 * 可以同時決定兩邊而繞過；綁定之後，他必須先知道受害者的 session token。
 */
export function csrfTokenFor(sessionToken: string): string {
  return createHash('sha256').update(`csrf:${sessionToken}`).digest('base64url');
}

/**
 * 認證不是 Command —— 它發生在 Actor 存在之前，沒有權限可以檢查。
 * 因此它是 Interface Adapter 直接呼叫的服務，而帳號管理仍走 Command Bus。
 */
export class AuthService {
  private readonly users = new UserRepository();

  /** TTL 依帳號角色而異：顧客的 session 活得比後台操作者久。 */
  constructor(
    private readonly sessionTtl: { operatorMs: number; customerMs: number },
    private readonly roles: ReleaseRoleCatalog,
    private readonly identity: IdentityServiceOptions,
  ) {}

  private ttlFor(role: string): number {
    const account = roleFor(this.roles, role)?.account;
    if (!account) throw new PlatformError('UNAUTHENTICATED', FAILED);
    return account.sessionTtl === 'customer' ? this.sessionTtl.customerMs : this.sessionTtl.operatorMs;
  }

  async authenticate(
    db: DrizzleDb,
    input: { email: string; password: string; userAgent?: string; mfaCode?: string; recoveryCode?: string },
  ): Promise<IssuedSession> {
    const user = await this.users.findByEmail(db, input.email);
    // 帳號不存在時也跑一次完整的 scrypt，讓兩條路徑的耗時不會洩漏帳號是否存在。
    const hash = user?.password_hash ?? (await DUMMY_HASH);
    const passwordOk = await verifyPassword(input.password, hash);

    const account = roleFor(this.roles, user?.role ?? '')?.account;
    if (!user || !passwordOk || user.status !== 'active' || !account) {
      if (user) await this.recordFailedLogin(db, user.id);
      throw new PlatformError('UNAUTHENTICATED', FAILED);
    }
    // 鎖定期間即使密碼正確也不放行，訊息與密碼錯誤完全一樣——
    // 「這個帳號被鎖了」本身就是「這個帳號存在」。
    // 這條路徑的驅動會把 timestamptz 交回字串，所以一律轉一次再比。
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      throw new PlatformError('UNAUTHENTICATED', FAILED);
    }

    let mfaEnrolmentRequired = false;
    if (account.mfa === 'required') {
      const status = await this.identity.mfa.statusFor(db, user.id);
      if (status.confirmed) {
        const passed = await this.identity.mfa.verifyForLogin(db, {
          userId: user.id, code: input.mfaCode, recoveryCode: input.recoveryCode,
        });

          if (!passed) {
          // 第二因素也算登入嘗試：只有密碼的攻擊者不該有無限次猜六位數的機會。
          await this.recordFailedLogin(db, user.id);
          throw new PlatformError('UNAUTHENTICATED', MFA_REQUIRED);
        }
      } else {
        // 第一個管理員得先登得進來才設定得了第二因素；旗標讓 UI 立刻把他帶過去。
        mfaEnrolmentRequired = true;
      }
    }

    await db.execute(sql`
      UPDATE platform_users SET failed_login_count = 0, locked_until = NULL
      WHERE id = ${user.id} AND (failed_login_count <> 0 OR locked_until IS NOT NULL)
    `);
    const session = await this.issueSession(db, user, input.userAgent);
    return mfaEnrolmentRequired ? { ...session, mfaEnrolmentRequired } : session;
  }

  /**
   * 這個 release 的自助註冊角色。沒有就是不開放自助註冊——
   * Commerce 就是這樣：它的顧客註冊要同時建立 Customer，是 commerce 自己的 command。
   */
  private selfServiceRole(): string | undefined {
    const matches = Object.entries(this.roles).filter(([, role]) => role.account && role.account.selfServiceRegistration);
    if (matches.length > 1) {
      throw PlatformError.internal(`Release declares more than one self-service role: ${matches.map(([name]) => name).join(', ')}`);
    }
    return matches[0]?.[0];
  }

  /**
   * 自助註冊。建帳號、寄驗證信、發 session 在同一個交易裡：
   * 註冊成功但沒收到驗證信，使用者是看不出來的，只會以為信箱打錯。
   */
  async register(input: { email: string; password: string; displayName?: string; userAgent?: string }): Promise<IssuedSession> {
    const role = this.selfServiceRole();
    if (!role) throw PlatformError.validation('This release does not offer self-service registration');
    assertPasswordLength(input.password, role, this.roles);

    return this.identity.database.transaction(async (tx) => {
      const created = await accountService.createAccount(tx, {
        email: input.email, password: input.password, role,
        displayName: input.displayName?.trim() || input.email.split('@')[0],
      });
      const user = (await this.users.findById(tx, created.id))!;
      const ttlMs = DEFAULT_VERIFICATION_TTL_MS;
      const issued = await this.identity.tokens.issue(tx, { userId: user.id, purpose: 'email-verification', ttlMs });
      await this.mailLink(tx, { user, issued, ttlMs, template: EMAIL_VERIFICATION_TEMPLATE, path: '/verify-email' });
      return this.issueSession(tx, user, input.userAgent);
    });
  }

  private async issueSession(
    db: DrizzleDb | Tx,
    user: { id: string; role: string } & Parameters<typeof toUserDto>[0],
    userAgent?: string,
  ): Promise<IssuedSession> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ttlFor(user.role));
    await db.execute(sql`
      INSERT INTO platform_sessions (id, user_id, token_hash, expires_at, user_agent)
      VALUES (${randomUUID()}, ${user.id}, ${hashToken(token)}, ${expiresAt.toISOString()}, ${userAgent ?? null})
    `);
    await db.execute(sql`UPDATE platform_users SET last_login_at = now() WHERE id = ${user.id}`);

    return { token, expiresAt, user: toUserDto(user) };
  }

  async resolveSession(db: DrizzleDb, token: string): Promise<ResolvedSession | null> {
    const res = await db.execute<{
      user_id: string; email: string; display_name: string; role: string; status: string;
      created_at: Date; last_login_at: Date | null;
    }>(sql`
      SELECT u.id AS user_id, u.email, u.display_name, u.role, u.status, u.created_at, u.last_login_at
      FROM platform_sessions s JOIN platform_users u ON u.id = s.user_id
      WHERE s.token_hash = ${hashToken(token)}
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
    `);
    const row = res.rows[0];
    if (!row || row.status !== 'active') return null;
    const role = roleFor(this.roles, row.role);
    if (!role?.account) return null;

    const user = toUserDto({
      id: row.user_id, email: row.email, password_hash: '', display_name: row.display_name,
      role: row.role, status: row.status, created_at: row.created_at, last_login_at: row.last_login_at,
    });
    return {
      user,
      actor: {
        // id 一律是帳號 id：顧客與後台操作者共用同一套帳號，分辨誰是誰的是 type。
        id: `user:${row.user_id}`,
        type: role.account.actorType,
        displayName: row.display_name,
        permissions: role.permissions,
      },
    };
  }

  /** 撤銷一個帳號的所有 session；`exceptToken` 讓「改密碼」不必把自己也踢掉。 */
  async revokeAllSessions(db: DrizzleDb, userId: string, exceptToken?: string): Promise<void> {
    const except = exceptToken ? hashToken(exceptToken) : null;
    await db.execute(sql`
      UPDATE platform_sessions SET revoked_at = now()
      WHERE user_id = ${userId} AND revoked_at IS NULL
        AND (${except}::text IS NULL OR token_hash <> ${except})
    `);
  }

  /**
   * 寄出重設連結。找不到帳號就什麼都不做——中性回應不是呼叫端的責任，
   * 是這裡就不產生任何可觀察的差異（不寄信、不寫列、不丟錯）。
   */
  async requestPasswordReset(input: { email: string; ttlMs?: number }): Promise<void> {
    await this.identity.database.transaction(async (tx) => {
      const user = await this.users.findByEmail(tx, input.email);
      if (!user || user.status !== 'active') return;
      const account = roleFor(this.roles, user.role)?.account;
      if (!account) return;

      // 先作廢舊的：不然「我又點了一次忘記密碼」會讓上一封信裡的連結繼續有效。
      await this.identity.tokens.invalidate(tx, user.id, 'password-reset');

      const requested = input.ttlMs ?? DEFAULT_RESET_TTL_MS;
      // 後台帳號改得了設定、看得到所有訂單。它的重設連結是一條接管後台的路徑，
      // 時效因此壓到四分之一——同一條流程，不同的暴露窗口。
      const ttlMs = account.sessionTtl === 'customer' ? requested : Math.min(requested, OPERATOR_RESET_TTL_MS);
      const issued = await this.identity.tokens.issue(tx, { userId: user.id, purpose: 'password-reset', ttlMs });
      await this.mailLink(tx, { user, issued, ttlMs, template: PASSWORD_RESET_TEMPLATE, path: '/reset-password' });
    });
  }

  /** 用重設 token 設定新密碼：單次使用、用過即作廢，並踢掉該帳號所有 session。 */
  async resetPassword(input: { token: string; newPassword: string }): Promise<UserDto> {
    return this.identity.database.transaction(async (tx) => {
      const consumed = await this.identity.tokens.consume(tx, { token: input.token, purpose: 'password-reset' });
      const user = await this.users.findById(tx, consumed.userId);
      if (!user || !roleFor(this.roles, user.role)?.account) {
        throw PlatformError.validation(IDENTITY_TOKEN_REJECTION);
      }
      assertPasswordLength(input.newPassword, user.role, this.roles);

      await tx.execute(sql`
        UPDATE platform_users SET password_hash = ${await hashPassword(input.newPassword)} WHERE id = ${user.id}
      `);
      // 重設密碼的情境就是「我不確定誰還登著」，因此一個 session 都不留。
      await this.revokeAllSessions(tx, user.id);
      return toUserDto({ ...user, password_hash: '' });
    });
  }

  /** 主動改密碼：驗過現有密碼才改，並踢掉其他裝置，留下自己這一台。 */
  async changePassword(
    db: DrizzleDb,
    input: { userId: string; currentPassword: string; newPassword: string; keepToken?: string },
  ): Promise<void> {
    const user = await this.users.findById(db, input.userId);
    if (!user || !roleFor(this.roles, user.role)?.account) throw new PlatformError('UNAUTHENTICATED', FAILED);
    if (!(await verifyPassword(input.currentPassword, user.password_hash))) {
      throw new PlatformError('UNAUTHENTICATED', FAILED);
    }
    assertPasswordLength(input.newPassword, user.role, this.roles);
    const passwordHash = await hashPassword(input.newPassword);

    await this.identity.database.transaction(async (tx) => {
      await tx.execute(sql`UPDATE platform_users SET password_hash = ${passwordHash} WHERE id = ${user.id}`);
      // 改完密碼，先前寄出的重設連結一律失效——那是「我懷疑帳號被盜」時最直接的期待。
      await this.identity.tokens.invalidate(tx, user.id, 'password-reset');
      await this.revokeAllSessions(tx, user.id, input.keepToken);
    });
  }

  /** 寄出（或重寄）信箱驗證信。已驗證過的地址也照寄：使用者可能只是找不到那封信。 */
  async requestEmailVerification(input: { userId: string; ttlMs?: number }): Promise<void> {
    await this.identity.database.transaction(async (tx) => {
      const user = await this.users.findById(tx, input.userId);
      if (!user || user.status !== 'active') return;
      await this.identity.tokens.invalidate(tx, user.id, 'email-verification');
      const ttlMs = input.ttlMs ?? DEFAULT_VERIFICATION_TTL_MS;
      const issued = await this.identity.tokens.issue(tx, { userId: user.id, purpose: 'email-verification', ttlMs });
      await this.mailLink(tx, { user, issued, ttlMs, template: EMAIL_VERIFICATION_TEMPLATE, path: '/verify-email' });
    });
  }

  async verifyEmail(input: { token: string }): Promise<UserDto> {
    return this.identity.database.transaction(async (tx) => {
      const consumed = await this.identity.tokens.consume(tx, { token: input.token, purpose: 'email-verification' });
      const result = await tx.execute<{ id: string }>(sql`
        UPDATE platform_users SET email_verified_at = now() WHERE id = ${consumed.userId} RETURNING id
      `);
      if (!result.rows[0]) throw PlatformError.validation(IDENTITY_TOKEN_REJECTION);
      const user = await this.users.findById(tx, consumed.userId);
      return toUserDto({ ...user!, password_hash: '' });
    });
  }

  /**
   * 換信箱要現有密碼，而且確認信只寄到新地址。兩者缺一都不夠：
   * 只驗密碼的話，一個被借走的瀏覽器就能把帳號搬走；只寄新地址的話，
   * 任何拿到 session 的人都能改。
   */
  async requestEmailChange(
    input: { userId: string; currentPassword: string; newEmail: string; ttlMs?: number },
  ): Promise<void> {
    await this.identity.database.transaction(async (tx) => {
      const user = await this.users.findById(tx, input.userId);
      if (!user || user.status !== 'active' || !roleFor(this.roles, user.role)?.account) {
        throw new PlatformError('UNAUTHENTICATED', FAILED);
      }
      if (!(await verifyPassword(input.currentPassword, user.password_hash))) {
        throw new PlatformError('UNAUTHENTICATED', FAILED);
      }
      const taken = await this.users.findByEmail(tx, input.newEmail);
      // 訊息不帶 email：帶了就等於在登入端辛苦做的中性訊息旁邊開一個枚舉窗口。
      if (taken) throw PlatformError.conflict('An account with these details already exists');

      await this.identity.tokens.invalidate(tx, user.id, 'email-change');
      const ttlMs = input.ttlMs ?? DEFAULT_VERIFICATION_TTL_MS;
      const issued = await this.identity.tokens.issue(tx, {
        userId: user.id, purpose: 'email-change', ttlMs, data: input.newEmail,
      });
      await this.mailLink(tx, {
        user, issued, ttlMs, template: EMAIL_CHANGE_TEMPLATE, path: '/confirm-email-change',
        to: input.newEmail, variables: { newEmail: input.newEmail },
      });
    });
  }

  async confirmEmailChange(input: { token: string }): Promise<UserDto> {
    return this.identity.database.transaction(async (tx) => {
      const consumed = await this.identity.tokens.consume(tx, { token: input.token, purpose: 'email-change' });
      if (!consumed.data) throw PlatformError.validation(IDENTITY_TOKEN_REJECTION);

      // 從寄出到點開之間，那個地址可能已經被別人註冊走了。
      const taken = await this.users.findByEmail(tx, consumed.data);
      if (taken && taken.id !== consumed.userId) {
        throw PlatformError.conflict('An account with these details already exists');
      }
      await tx.execute(sql`
        UPDATE platform_users SET email = ${consumed.data}, email_verified_at = now() WHERE id = ${consumed.userId}
      `);
      const user = await this.users.findById(tx, consumed.userId);
      return toUserDto({ ...user!, password_hash: '' });
    });
  }

  private async mailLink(
    tx: Tx,
    input: {
      user: { id: string; email: string; display_name: string };
      issued: { id: string; token: string };
      ttlMs: number;
      template: MailTemplate;
      path: string;
      to?: string;
      variables?: Record<string, string>;
    },
  ): Promise<void> {
    const url = `${this.identity.publicUrl}${input.path}?token=${encodeURIComponent(input.issued.token)}`;
    const request: MailSendRequest = {
      // token id 進 reference：同一個帳號連按兩次忘記密碼是兩封信，不是一封被去重掉。
      reference: `${input.template.id}:${input.issued.id}`,
      to: [{ email: input.to ?? input.user.email, name: input.user.display_name }],
      locale: this.identity.locale,
      template: input.template,
      variables: {
        storeName: this.identity.storeName,
        displayName: input.user.display_name,
        url,
        expiresInMinutes: String(Math.max(1, Math.round(input.ttlMs / 60_000))),
        ...input.variables,
      },
    };
    await this.identity.mail.queue(tx, request);
  }

  /** 記一次失敗；到門檻就上鎖。計數寫在同一句 UPDATE 裡，並行的失敗不會互相覆蓋。 */
  private async recordFailedLogin(db: DrizzleDb, userId: string): Promise<void> {
    await db.execute(sql`
      UPDATE platform_users
      SET failed_login_count = failed_login_count + 1,
          locked_until = CASE
            WHEN failed_login_count + 1 >= ${MAX_FAILED_LOGINS}
            THEN now() + ${`${LOCKOUT_MS} milliseconds`}::interval
            ELSE locked_until
          END
      WHERE id = ${userId}
    `);
  }

  /** 驗證某個帳號的現有密碼。關閉第二因素這類降級動作要有它，不只有 session。 */
  async assertPassword(userId: string, password: string): Promise<void> {
    const user = await this.users.findById(this.identity.database.db, userId);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      throw new PlatformError('UNAUTHENTICATED', FAILED);
    }
  }

  async revokeSession(db: DrizzleDb, token: string): Promise<void> {
    await db.execute(sql`
      UPDATE platform_sessions SET revoked_at = now()
      WHERE token_hash = ${hashToken(token)} AND revoked_at IS NULL
    `);
  }
}
