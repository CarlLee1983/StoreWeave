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
  async createAccount(
    tx: Tx,
    input: { email: string; password: string; displayName: string; role: string },
  ): Promise<UserDto> {
    const existing = await repository.findByEmail(tx as unknown as DrizzleDb, input.email);
    if (existing) throw PlatformError.conflict(`Account ${input.email} already exists`);

    const row = await repository.insert(tx, {
      id: randomUUID(),
      email: input.email,
      passwordHash: await hashPassword(input.password),
      displayName: input.displayName,
      role: input.role,
    });
    return toUserDto(row);
  },
};
