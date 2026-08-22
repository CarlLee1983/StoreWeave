import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { IssuedSession } from '@storeweave/identity';
import { cartMergeNotice, clearGuestCartCookie, setCartNoticeCookie } from './cart-cookie';
import { CART_COOKIE, readCookie } from './cookie-names';
import { setSessionCookies } from './session-cookies';
import type { AuthenticatedRequest } from './auth';
import type { Runtime } from '../tokens';

/**
 * 簽發 session 的**唯一**入口。
 *
 * 購物車合併的時機是「身分出現的那一刻」，而那一刻在四個地方各發生一次
 * （後台登入、前台登入、前台註冊、REST 註冊）。把它綁在發 cookie 這個動作上，
 * 新的登入入口就不可能忘記合併——這是工單 12「同一個不變式只套了一半」的教訓。
 */
export async function startSession(
  runtime: Runtime,
  req: AuthenticatedRequest,
  reply: FastifyReply,
  session: IssuedSession,
): Promise<string | null> {
  const publicUrl = runtime.config.http.publicUrl;
  setSessionCookies(reply, { publicUrl, token: session.token, expiresAt: session.expiresAt });

  // 這裡不用 existingGuestToken()：它會對已登入的身分回 undefined，而這一刻正是身分出現的瞬間。
  const guestToken = readCookie(req.cookies, CART_COOKIE, publicUrl);
  if (!guestToken) return null;

  try {
    const resolved = await runtime.auth.resolveSession(runtime.database.db, session.token);
    // 後台帳號沒有購物車可以併；訪客那台車留著，登出後還找得回來。
    if (!resolved || resolved.actor.type !== 'customer') return null;

    const merged = await runtime.commands.execute<{ removedNames: string[] }>(
      'commerce.cart.mergeGuestCart',
      { guestToken },
      // 冪等鍵用現產的值：session token 與訪客 token 都是秘密，不進資料表。
      // 合併本身取較大值又會把來源車作廢，重跑一次不會多算。
      { actor: resolved.actor, idempotencyKey: randomUUID(), channel: 'rest' },
    );
    clearGuestCartCookie(reply, publicUrl);

    const notice = cartMergeNotice(merged.removedNames);
    if (notice) setCartNoticeCookie(reply, publicUrl, notice);
    return notice;
  } catch (err) {
    // 合併失敗不該讓人登不進來——購物車還在訪客那台車上，下一次登入會再試一次。
    runtime.logger.error({ error: (err as Error).message }, 'guest cart merge failed');
    return null;
  }
}
