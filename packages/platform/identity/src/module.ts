import packageJson from '../package.json';
import { z } from 'zod';
import { PlatformError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@storeweave/contracts';
import { COMMERCE_ROLES, roleFor, type ReleaseRoleCatalog } from '@storeweave/authorization';
// 只取型別：kernel 會在執行期匯入這個模組，反向的執行期相依會形成循環。
import type { PlatformModule } from '@storeweave/kernel';
import { identityMigrations } from './migrations';
import { IDENTITY_CLEANUP_JOB, createIdentityCleanupJob, identityCleanupPayload, type IdentityCleanupDeps } from './jobs';
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
}).strict();

export const setUserStatusInput = z.object({
  userId: z.string().uuid(),
  status: z.enum(['active', 'disabled']),
}).strict();

export const setUserStatusCommand = defineCommand({
  name: 'platform.identity.setUserStatus',
  summary: '啟用或停用一個帳號，停用時撤銷它所有的 session',
  input: setUserStatusInput,
  output: userDto,
  permission: 'users:write',
  idempotency: 'optional',
  audit: { action: 'user.status-changed', resourceType: 'user', resourceId: (input) => input.userId },
  // Policy 需要知道動的是哪一個帳號，否則它只知道「有人要動一個 user」。
  resource: (input) => ({ id: input.userId, attributes: { status: input.status } }),
});

export const listUsersInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
}).strict();

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

export function createIdentityModule(
  roles: ReleaseRoleCatalog,
  /** Deferred：模組在 runtime 資源存在之前就要組好，清理工作的相依只能晚一步取。 */
  cleanup: () => IdentityCleanupDeps | undefined = () => undefined,
): PlatformModule {
  return {
    name: IDENTITY_MODULE_NAME,
    version: packageJson.version,
    baseVersionRange: '^1.0.0',
    dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }] },
    data: { owns: ['platform_users', 'platform_sessions', 'platform_identity_tokens', 'platform_api_tokens', 'platform_user_mfa', 'platform_mfa_recovery_codes'] },
    migrations: identityMigrations,
    permissions: [
      { key: 'users:read', description: '檢視後台操作者帳號', owner: IDENTITY_MODULE_NAME },
      { key: 'users:write', description: '建立與停用後台操作者帳號', owner: IDENTITY_MODULE_NAME },
    ],
    jobs: [
      {
        type: IDENTITY_CLEANUP_JOB,
        handler: createIdentityCleanupJob(cleanup),
        jobContractV1: { currentVersion: 1, versions: { 1: identityCleanupPayload } },
        // 一天一次：保留期以週計，晚幾小時清掉沒有人會察覺。
        schedule: { everyMs: 24 * 60 * 60 * 1000 },
      },
    ],
    policies: [
      {
        id: 'platform-identity.no-self-disable',
        appliesTo: ['users:write'],
        owner: IDENTITY_MODULE_NAME,
        reason: 'An operator cannot disable their own account',
        // 停用自己會把最後一個管理員關在門外，而復原需要另一個管理員——
        // 這正是「沒有另一個管理員」時做不到的事。
        evaluate: (input) => (
          input.resource?.type === 'identity'
          && input.resource.attributes?.status === 'disabled'
          && input.actor.id === `user:${input.resource.id}`
            ? 'deny'
            : 'abstain'
        ),
      },
    ],
    commands: [
      {
        descriptor: createUserCommand,
        handler: async (input: z.infer<typeof createUserInput>, ctx: CommandContext) => {
          const role = roleFor(roles, input.role);
          if (!role?.account) {
            throw PlatformError.validation(`Unknown role "${input.role}"; expected one of ${Object.keys(roles).join(', ')}`);
          }
          if (!role.account.adminCreatable) {
            throw PlatformError.validation('Customer accounts are created by signing up, not from the admin console');
          }
          if (input.password.length < role.account.minPasswordLength) {
            throw PlatformError.validation(`Password must be at least ${role.account.minPasswordLength} characters`);
          }
          return accountService.createAccount(ctx.tx, input);
        },
      },
      {
        descriptor: setUserStatusCommand,
        handler: async (input: z.infer<typeof setUserStatusInput>, ctx: CommandContext) => {
          await accountService.setStatus(ctx.tx, input.userId, input.status);
          const row = await repository.findById(ctx.tx, input.userId);
          if (!row) throw PlatformError.notFound('Account', input.userId);
          return toUserDto(row);
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
}

/** Legacy Commerce composition export. New releases supply their catalog explicitly. */
export const identityModule = /* @__PURE__ */ createIdentityModule(COMMERCE_ROLES);
