import { sql } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';

export interface UserRow {
  [key: string]: unknown;
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: string;
  status: string;
  created_at: Date;
  last_login_at: Date | null;
}

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
}

/** DTO 不含 password_hash —— 雜湊永遠不離開這一層。 */
export function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
  };
}

export class UserRepository {
  async insert(tx: Tx, input: {
    id: string; email: string; passwordHash: string; displayName: string; role: string;
  }): Promise<UserRow> {
    const res = await tx.execute<UserRow>(sql`
      INSERT INTO platform_users (id, email, password_hash, display_name, role)
      VALUES (${input.id}, ${input.email}, ${input.passwordHash}, ${input.displayName}, ${input.role})
      RETURNING id, email, password_hash, display_name, role, status, created_at, last_login_at
    `);
    return res.rows[0]!;
  }

  async findById(db: DrizzleDb | Tx, id: string): Promise<UserRow | null> {
    const res = await db.execute<UserRow>(sql`
      SELECT id, email, password_hash, display_name, role, status, created_at, last_login_at
      FROM platform_users WHERE id = ${id}
    `);
    return res.rows[0] ?? null;
  }

  /** 撞到 email 唯一索引時回 null，讓呼叫端把它變成 409 而不是 500。 */
  async insertIfAbsent(tx: Tx, input: {
    id: string; email: string; passwordHash: string; displayName: string; role: string;
  }): Promise<UserRow | null> {
    const res = await tx.execute<UserRow>(sql`
      INSERT INTO platform_users (id, email, password_hash, display_name, role)
      VALUES (${input.id}, ${input.email}, ${input.passwordHash}, ${input.displayName}, ${input.role})
      ON CONFLICT DO NOTHING
      RETURNING id, email, password_hash, display_name, role, status, created_at, last_login_at
    `);
    return res.rows[0] ?? null;
  }

  async setDisplayName(tx: Tx, id: string, displayName: string): Promise<void> {
    await tx.execute(sql`UPDATE platform_users SET display_name = ${displayName} WHERE id = ${id}`);
  }

  async findByEmail(db: DrizzleDb | Tx, email: string): Promise<UserRow | null> {
    const res = await db.execute<UserRow>(sql`
      SELECT id, email, password_hash, display_name, role, status, created_at, last_login_at
      FROM platform_users WHERE lower(email) = lower(${email})
    `);
    return res.rows[0] ?? null;
  }

  async list(db: DrizzleDb, options: { limit: number; offset: number }): Promise<{ items: UserRow[]; total: number }> {
    const res = await db.execute<UserRow>(sql`
      SELECT id, email, password_hash, display_name, role, status, created_at, last_login_at
      FROM platform_users ORDER BY created_at ASC LIMIT ${options.limit} OFFSET ${options.offset}
    `);
    const count = await db.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM platform_users`);
    return { items: res.rows, total: Number(count.rows[0]?.count ?? 0) };
  }
}
