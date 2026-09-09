import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { PlatformError, type DrizzleDb, type Tx } from '@storeweave/contracts';
import { roleFor, type ReleaseRoleCatalog } from '@storeweave/authorization';

/**
 * 機器對機器的 token。與帳號的差別只有一個：沒有人可以用它登入，
 * 所以它不需要密碼、session 或信箱，但同樣需要到期與撤銷。
 *
 * 格式 `swt1.<id>.<secret>`：id 讓查詢是一次索引命中，秘密本身只存 sha256。
 * 設定檔驅動的舊做法沒有到期也不能個別撤銷，等於一把改不掉的萬能鑰匙（ADR 0043）。
 */
const PREFIX = 'swt1';
const SECRET_BYTES = 32;

export interface ApiTokenSummary {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface IssuedApiToken extends ApiTokenSummary {
  /** 只有簽發的當下看得到。系統自己也讀不回來。 */
  readonly secret: string;
}

export interface ResolvedApiToken {
  readonly id: string;
  readonly name: string;
  readonly role: string;
}

interface TokenRow extends Record<string, unknown> {
  id: string; name: string; role: string; token_hash: string;
  created_at: Date; expires_at: Date; last_used_at: Date | null; revoked_at: Date | null;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function summary(row: TokenRow): ApiTokenSummary {
  return {
    id: row.id, name: row.name, role: row.role, createdAt: row.created_at,
    expiresAt: row.expires_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at,
  };
}

export class ApiTokenService {
  constructor(private readonly roles: ReleaseRoleCatalog) {}

  /**
   * 簽發。角色必須是這個 release 允許給 token 的角色——
   * 指成 customer 會產生一個「看得到全部訂單的顧客」，那是資料範圍的漏洞而不是設定錯誤。
   */
  async issue(
    tx: Tx,
    input: { name: string; role: string; ttlMs: number; createdBy?: string },
  ): Promise<IssuedApiToken> {
    const role = roleFor(this.roles, input.role);
    if (!role) throw PlatformError.validation(`Unknown role "${input.role}"`);
    if (!role.tokenAllowed) throw PlatformError.validation(`Role "${input.role}" cannot be used by an API token`);
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) throw PlatformError.validation('An API token needs a positive lifetime');

    const id = randomUUID();
    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + input.ttlMs);
    const inserted = await tx.execute<TokenRow>(sql`
      INSERT INTO platform_api_tokens (id, name, role, token_hash, expires_at, created_by)
      VALUES (${id}, ${input.name}, ${input.role}, ${hashSecret(secret)}, ${expiresAt.toISOString()}, ${input.createdBy ?? null})
      ON CONFLICT (name) DO NOTHING
      RETURNING *
    `);
    const row = inserted.rows[0];
    if (!row) throw PlatformError.conflict(`An API token named "${input.name}" already exists`);
    return { ...summary(row), secret: `${PREFIX}.${id}.${secret}` };
  }

  /**
   * 驗證一個 bearer token。過期、撤銷、角色已從 release 移除都回 null——
   * 呼叫端只需要知道「這不是一個有效的身分」。
   */
  async resolve(db: DrizzleDb, presented: string): Promise<ResolvedApiToken | null> {
    const parts = presented.split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX) return null;
    const [, id, secret] = parts;
    // uuid 以外的 id 直接擋掉：不然每一個亂猜的 bearer 都變成一次資料庫查詢。
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return null;

    const result = await db.execute<TokenRow>(sql`
      SELECT * FROM platform_api_tokens
      WHERE id = ${id} AND revoked_at IS NULL AND expires_at > now()
    `);
    const row = result.rows[0];
    if (!row) return null;

    const expected = Buffer.from(row.token_hash, 'utf8');
    const actual = Buffer.from(hashSecret(secret), 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    if (!roleFor(this.roles, row.role)?.tokenAllowed) return null;

    // 最後使用時間是輪替的依據：沒有人敢撤銷一個不知道還有沒有人在用的 token。
    // 每分鐘最多寫一次，免得每個請求都變成一次寫入。
    await db.execute(sql`
      UPDATE platform_api_tokens SET last_used_at = now()
      WHERE id = ${row.id} AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')
    `);
    return { id: row.id, name: row.name, role: row.role };
  }

  async list(db: DrizzleDb | Tx): Promise<readonly ApiTokenSummary[]> {
    const result = await db.execute<TokenRow>(sql`
      SELECT * FROM platform_api_tokens ORDER BY created_at
    `);
    return result.rows.map(summary);
  }

  /** 撤銷是立即的：下一個請求就不通過，不必等快取或重啟。 */
  async revoke(tx: Tx, name: string): Promise<ApiTokenSummary> {
    const result = await tx.execute<TokenRow>(sql`
      UPDATE platform_api_tokens SET revoked_at = now()
      WHERE name = ${name} AND revoked_at IS NULL
      RETURNING *
    `);
    const row = result.rows[0];
    if (!row) throw PlatformError.notFound('ApiToken', name);
    return summary(row);
  }
}
