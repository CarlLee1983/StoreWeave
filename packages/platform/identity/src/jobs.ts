import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '@storeweave/contracts';
import type { JobHandler } from '@storeweave/jobs';
import type { IdentityTokenService } from './tokens';

export const IDENTITY_CLEANUP_JOB = 'platform.identity.cleanup';

export const identityCleanupPayload = z.object({
  bucket: z.number().int(),
  scheduledFor: z.string().datetime(),
}).strict();

export interface IdentityCleanupDeps {
  readonly database: { transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> };
  readonly tokens: IdentityTokenService;
}

/** 已使用的 token 留這麼久，好讓「我點了連結但沒生效」的客訴還查得到那一列。 */
const USED_TOKEN_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * 過期的 token 與 session 沒有稽核價值，留著只是一份會愈長愈大的個人資料。
 * 清理是排程工作而不是人的責任：靠人記得的保留期一定會被忘記。
 */
export function createIdentityCleanupJob(deps: () => IdentityCleanupDeps | undefined): JobHandler {
  return async () => {
    const resolved = deps();
    if (!resolved) return;
    await resolved.database.transaction(async (tx) => {
      await resolved.tokens.purge(tx, USED_TOKEN_RETENTION_MS);
      // 已到期或已撤銷的 session 不會再被解析，但 user_agent 是可辨識資料。
      await tx.execute(sql`
        DELETE FROM platform_sessions
        WHERE expires_at < now() - interval '30 days'
           OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')
      `);
    });
  };
}
