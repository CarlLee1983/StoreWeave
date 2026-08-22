import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { PlatformError, type Actor, type DrizzleDb } from '@storeweave/contracts';
import { permissionsForRole } from '@storeweave/authorization';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password';
import { UserRepository, toUserDto, type UserDto } from './repository';

export interface IssuedSession {
  token: string;
  expiresAt: Date;
  user: UserDto;
}

export interface ResolvedSession {
  actor: Actor;
  user: UserDto;
}

/**
 * 密碼長度下限依角色而異：後台帳號改得了設定、看得到所有訂單，門檻高一點；
 * 前台會員以長度優先、不強制大小寫與符號（複雜度規則只會逼出可預測的變形）。
 */
export function minPasswordLengthFor(role: string): number {
  return role === CUSTOMER_ROLE ? 8 : 12;
}

function assertPasswordLength(password: string, role: string): void {
  const min = minPasswordLengthFor(role);
  if (password.length < min) {
    throw new PlatformError('VALIDATION_ERROR', `Password must be at least ${min} characters`);
  }
}

/** 顧客帳號的角色名。identity 只認得「這是一個角色」，顧客的領域資料在 commerce/customer。 */
export const CUSTOMER_ROLE = 'customer';

/** 認證失敗一律用同一句話：區分「沒這個帳號」與「密碼錯」等於送出帳號枚舉管道。 */
const FAILED = 'Invalid email or password';

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
  constructor(private readonly sessionTtl: { operatorMs: number; customerMs: number }) {}

  private ttlFor(role: string): number {
    return role === CUSTOMER_ROLE ? this.sessionTtl.customerMs : this.sessionTtl.operatorMs;
  }

  async authenticate(
    db: DrizzleDb,
    input: { email: string; password: string; userAgent?: string },
  ): Promise<IssuedSession> {
    const user = await this.users.findByEmail(db, input.email);
    // 帳號不存在時也跑一次完整的 scrypt，讓兩條路徑的耗時不會洩漏帳號是否存在。
    const hash = user?.password_hash ?? (await DUMMY_HASH);
    const passwordOk = await verifyPassword(input.password, hash);

    if (!user || !passwordOk || user.status !== 'active') {
      throw new PlatformError('UNAUTHENTICATED', FAILED);
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ttlFor(user.role));
    await db.execute(sql`
      INSERT INTO platform_sessions (id, user_id, token_hash, expires_at, user_agent)
      VALUES (${randomUUID()}, ${user.id}, ${hashToken(token)}, ${expiresAt.toISOString()}, ${input.userAgent ?? null})
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

    const user = toUserDto({
      id: row.user_id, email: row.email, password_hash: '', display_name: row.display_name,
      role: row.role, status: row.status, created_at: row.created_at, last_login_at: row.last_login_at,
    });
    return {
      user,
      actor: {
        // id 一律是帳號 id：顧客與後台操作者共用同一套帳號，分辨誰是誰的是 type。
        id: `user:${row.user_id}`,
        type: row.role === CUSTOMER_ROLE ? 'customer' : 'user',
        displayName: row.display_name,
        permissions: permissionsForRole(row.role),
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
   * 產生重設 token。找不到帳號時回 null——呼叫端一律回中性訊息，
   * 由它決定「什麼都不做」，而不是由這裡丟出可辨識的錯誤。
   */
  async createPasswordReset(
    db: DrizzleDb,
    input: { email: string; ttlMs: number },
  ): Promise<{ token: string; user: UserDto } | null> {
    const user = await this.users.findByEmail(db, input.email);
    if (!user || user.status !== 'active') return null;

    // 先作廢舊的：不然「我又點了一次忘記密碼」會讓上一封信裡的連結繼續有效。
    await db.execute(sql`
      UPDATE platform_password_resets SET used_at = now() WHERE user_id = ${user.id} AND used_at IS NULL
    `);

    const token = randomBytes(32).toString('base64url');
    await db.execute(sql`
      INSERT INTO platform_password_resets (id, user_id, token_hash, expires_at)
      VALUES (${randomUUID()}, ${user.id}, ${hashToken(token)}, ${new Date(Date.now() + input.ttlMs).toISOString()})
    `);
    return { token, user: toUserDto(user) };
  }

  /** 用重設 token 設定新密碼：單次使用、用過即作廢，並踢掉該帳號所有 session。 */
  async resetPassword(db: DrizzleDb, input: { token: string; newPassword: string }): Promise<UserDto> {
    const res = await db.execute<{ id: string; user_id: string; role: string }>(sql`
      SELECT r.id, r.user_id, u.role
      FROM platform_password_resets r JOIN platform_users u ON u.id = r.user_id
      WHERE r.token_hash = ${hashToken(input.token)} AND r.used_at IS NULL AND r.expires_at > now()
    `);
    const row = res.rows[0];
    if (!row) throw new PlatformError('VALIDATION_ERROR', 'This reset link is invalid or has expired');

    assertPasswordLength(input.newPassword, row.role);

    await db.execute(sql`
      UPDATE platform_users SET password_hash = ${await hashPassword(input.newPassword)} WHERE id = ${row.user_id}
    `);
    await db.execute(sql`UPDATE platform_password_resets SET used_at = now() WHERE id = ${row.id}`);
    // 重設密碼的情境就是「我不確定誰還登著」，因此一個 session 都不留。
    await this.revokeAllSessions(db, row.user_id);

    const user = await this.users.findById(db, row.user_id);
    return toUserDto(user!);
  }

  /** 主動改密碼：驗過現有密碼才改，並踢掉其他裝置，留下自己這一台。 */
  async changePassword(
    db: DrizzleDb,
    input: { userId: string; currentPassword: string; newPassword: string; keepToken?: string },
  ): Promise<void> {
    const user = await this.users.findById(db, input.userId);
    if (!user) throw new PlatformError('UNAUTHENTICATED', FAILED);
    if (!(await verifyPassword(input.currentPassword, user.password_hash))) {
      throw new PlatformError('UNAUTHENTICATED', FAILED);
    }
    assertPasswordLength(input.newPassword, user.role);

    await db.execute(sql`
      UPDATE platform_users SET password_hash = ${await hashPassword(input.newPassword)} WHERE id = ${user.id}
    `);
    // 改完密碼，先前寄出的重設連結一律失效——那是「我懷疑帳號被盜」時最直接的期待。
    await db.execute(sql`
      UPDATE platform_password_resets SET used_at = now() WHERE user_id = ${user.id} AND used_at IS NULL
    `);
    await this.revokeAllSessions(db, user.id, input.keepToken);
  }

  async revokeSession(db: DrizzleDb, token: string): Promise<void> {
    await db.execute(sql`
      UPDATE platform_sessions SET revoked_at = now()
      WHERE token_hash = ${hashToken(token)} AND revoked_at IS NULL
    `);
  }
}
