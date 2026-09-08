import { randomUUID } from 'node:crypto';
import { PlatformError, type DrizzleDb, type Tx } from '@storeweave/contracts';
import { hashPassword } from './password';
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

  async createAccount(
    tx: Tx,
    input: { email: string; password: string; displayName: string; role: string },
  ): Promise<UserDto> {
    // 訊息不帶 email：帶了就等於把登入端辛苦做的中性訊息從註冊端繞過去。
    const conflict = PlatformError.conflict('An account with these details already exists');
    const existing = await repository.findByEmail(tx, input.email);
    if (existing) throw conflict;

    // 先查再寫擋不住並行：兩個請求可以同時通過上面的檢查，第二個會撞唯一索引。
    const row = await repository.insertIfAbsent(tx, {
      id: randomUUID(),
      email: input.email,
      passwordHash: await hashPassword(input.password),
      displayName: input.displayName,
      role: input.role,
    });
    if (!row) throw conflict;
    return toUserDto(row);
  },
};
