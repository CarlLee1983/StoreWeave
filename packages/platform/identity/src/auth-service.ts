import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { PlatformError, type Actor, type DrizzleDb } from '@storeweave/contracts';
import { permissionsForRole } from '@storeweave/authorization';
import { DUMMY_HASH, verifyPassword } from './password';
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

  constructor(private readonly sessionTtlMs: number) {}

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
    const expiresAt = new Date(Date.now() + this.sessionTtlMs);
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
        id: `user:${row.user_id}`,
        type: 'user',
        displayName: row.display_name,
        permissions: permissionsForRole(row.role),
      },
    };
  }

  async revokeSession(db: DrizzleDb, token: string): Promise<void> {
    await db.execute(sql`
      UPDATE platform_sessions SET revoked_at = now()
      WHERE token_hash = ${hashToken(token)} AND revoked_at IS NULL
    `);
  }
}
