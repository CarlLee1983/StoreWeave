import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { PlatformError, type DrizzleDb, type Tx } from '@storeweave/contracts';
import { UserRepository, toUserDto, type UserDto } from './repository';

const repository = new UserRepository();

/**
 * 建立帳號的唯一入口。commerce 模組（顧客註冊）與後台的建帳號命令都走它，
 * 密碼雜湊因此只有一份實作，安全性修補也只需要做一次。
 *
 * 它收 `tx` 而不是自己開交易：顧客註冊要讓帳號與顧客資料同生共死。
 */
export const accountService = {
  /** Contact projection for domain modules; password and session fields stay in Identity. */
  async contactFor(db: DrizzleDb | Tx, accountId: string): Promise<{ email: string } | null> {
    const account = await repository.findById(db, accountId);
    return account ? { email: account.email } : null;
  },

  /** 帳號標籤跟著顧客的顯示名稱走：兩邊各存一份、只改一邊，畫面就會永遠對不起來。 */
  async setDisplayName(tx: Tx, accountId: string, displayName: string): Promise<void> {
    await repository.setDisplayName(tx, accountId, displayName);
  },

  /**
   * 啟用或停用一個帳號。停用同時撤銷所有 session——只把狀態改掉的話，
   * 已經登入的人還握著一個有效的 session，那不是「停用」。
   *
   * 這是 identity 擁有的表，所以別的模組要改帳號狀態得走這裡，不是自己下 UPDATE。
   */
  async setStatus(tx: Tx, accountId: string, status: 'active' | 'disabled'): Promise<void> {
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE platform_users SET status = ${status}, updated_at = now()
      WHERE id = ${accountId} RETURNING id
    `);
    if (!updated.rows[0]) throw PlatformError.notFound('Account', accountId);
    if (status === 'disabled') {
      await tx.execute(sql`
        UPDATE platform_sessions SET revoked_at = now()
        WHERE user_id = ${accountId} AND revoked_at IS NULL
      `);
    }
  },

  /**
   * 收已經算好的雜湊而不是明文密碼：scrypt 要跑上百毫秒，在交易裡跑等於
   * 那段時間一直佔著一條連線。呼叫端在開交易之前算好，能挪多少算多少。
   */
  async createAccount(
    tx: Tx,
    input: { email: string; passwordHash: string; displayName: string; role: string },
  ): Promise<UserDto> {
    // 訊息不帶 email：帶了就等於把登入端辛苦做的中性訊息從註冊端繞過去。
    const conflict = PlatformError.conflict('An account with these details already exists');
    const existing = await repository.findByEmail(tx, input.email);
    if (existing) throw conflict;

    // 先查再寫擋不住並行：兩個請求可以同時通過上面的檢查，第二個會撞唯一索引。
    const row = await repository.insertIfAbsent(tx, {
      id: randomUUID(),
      email: input.email,
      passwordHash: input.passwordHash,
      displayName: input.displayName,
      role: input.role,
    });
    if (!row) throw conflict;
    return toUserDto(row);
  },
};
