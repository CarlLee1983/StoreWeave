import { z } from 'zod';
import { PlatformError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@storeweave/contracts';
import { BUILT_IN_ROLES } from '@storeweave/authorization';
// 只取型別：kernel 會在執行期匯入這個模組，反向的執行期相依會形成循環。
import type { PlatformModule } from '@storeweave/kernel';
import { identityMigrations } from './migrations';
import { accountService } from './account-service';
import { UserRepository, toUserDto } from './repository';

export const IDENTITY_MODULE_NAME = 'platform-identity';

const repository = new UserRepository();

export const userDto = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.string(),
  status: z.string(),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
});

/**
 * 12 個字元是刻意的下限：scrypt 擋得住離線暴力破解的前提是密碼本身有足夠熵，
 * 而複雜度規則（大小寫、符號）已被證實只會逼出可預測的變形。
 */
export const createUserInput = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  displayName: z.string().min(1).max(120),
  role: z.string(),
});

export const listUsersInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export const createUserCommand = defineCommand({
  name: 'platform.identity.createUser',
  summary: '建立一個後台操作者帳號',
  input: createUserInput,
  output: userDto,
  permission: 'users:write',
  idempotency: 'required',
  audit: { action: 'user.created', resourceType: 'user', resourceId: (_i, o) => o.id },
});

export const listUsersQuery = defineQuery({
  name: 'platform.identity.listUsers',
  summary: '列出後台操作者帳號',
  input: listUsersInput,
  output: z.object({ items: z.array(userDto), total: z.number() }),
  permission: 'users:read',
});

export const identityModule: PlatformModule = {
  name: IDENTITY_MODULE_NAME,
  migrations: identityMigrations,
  permissions: [
    { key: 'users:read', description: '檢視後台操作者帳號', owner: IDENTITY_MODULE_NAME },
    { key: 'users:write', description: '建立與停用後台操作者帳號', owner: IDENTITY_MODULE_NAME },
  ],
  commands: [
    {
      descriptor: createUserCommand,
      handler: async (input: z.infer<typeof createUserInput>, ctx: CommandContext) => {
        // `in` 會把 constructor / toString / __proto__ 這些原型鏈上的鍵當成合法角色。
        if (!Object.hasOwn(BUILT_IN_ROLES, input.role)) {
          throw PlatformError.validation(
            `Unknown role "${input.role}"; expected one of ${Object.keys(BUILT_IN_ROLES).join(', ')}`,
          );
        }
        return accountService.createAccount(ctx.tx, input);
      },
    },
  ],
  queries: [
    {
      descriptor: listUsersQuery,
      handler: async (input: z.infer<typeof listUsersInput>, ctx: QueryContext) => {
        const { items, total } = await repository.list(ctx.db, input);
        return { items: items.map(toUserDto), total };
      },
    },
  ],
};
