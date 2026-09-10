import type { FastifyReply } from 'fastify';
import { clearSessionCookies, sessionTokenOf } from './session-cookies';
import type { AuthenticatedRequest } from './auth';
import type { Runtime } from '../tokens';

/**
 * 結束一次登入：作廢資料庫那一張，再清掉瀏覽器那兩張。
 *
 * 和簽發不同，這裡沒有 release 之間的差異，所以不經 adapter——訪客購物車刻意留著，
 * 登出之後還找得回來（`session-start.ts` 的註解說明了為什麼那台車不跟著身分走）。
 */
export async function clearSession(
  runtime: Runtime,
  req: AuthenticatedRequest,
  reply: FastifyReply,
): Promise<void> {
  const publicUrl = runtime.config.http.publicUrl;
  try {
    const token = sessionTokenOf(req, publicUrl);
    if (token) await runtime.auth.revokeSession(runtime.database.db, token);
  } finally {
    // 作廢失敗（資料庫抖一下）也一定要把 cookie 清掉：留下一個「還登著」的錯誤頁，
    // 在共用電腦上就是把帳號留給下一個人。錯誤照樣往上拋，所以不會送出 303。
    clearSessionCookies(reply, publicUrl);
  }
}
