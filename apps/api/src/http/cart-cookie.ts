import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';

/** 訪客購物車的識別碼。會員不需要它——他們的車綁在身分上。 */
export const CART_COOKIE = 'commerce_cart';

/**
 * 合併結果的一次性提示。合併發生在轉址之前，訊息沒有地方可以放，
 * 因此走 cookie 送到下一頁，讀到就清掉。
 */
export const CART_NOTICE_COOKIE = 'commerce_cart_notice';

const CART_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const NOTICE_MAX_AGE = 5 * 60;

function secureFor(publicUrl: string): boolean {
  const { protocol, hostname } = new URL(publicUrl);
  return protocol === 'https:' || !['localhost', '127.0.0.1', '::1'].includes(hostname);
}

export function setGuestCartCookie(reply: FastifyReply, publicUrl: string): string {
  const token = randomBytes(32).toString('base64url');
  reply.setCookie(CART_COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: secureFor(publicUrl), maxAge: CART_COOKIE_MAX_AGE,
  });
  return token;
}

/** 併過的 token 立刻失效，留著只會讓下一次請求又去找一台已經作廢的車。 */
export function clearGuestCartCookie(reply: FastifyReply, publicUrl: string): void {
  reply.clearCookie(CART_COOKIE, { path: '/', sameSite: 'lax', secure: secureFor(publicUrl), httpOnly: true });
}

export function setCartNoticeCookie(reply: FastifyReply, publicUrl: string, message: string): void {
  reply.setCookie(CART_NOTICE_COOKIE, message, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: secureFor(publicUrl), maxAge: NOTICE_MAX_AGE,
  });
}

export function clearCartNoticeCookie(reply: FastifyReply, publicUrl: string): void {
  reply.clearCookie(CART_NOTICE_COOKIE, { path: '/', sameSite: 'lax', secure: secureFor(publicUrl), httpOnly: true });
}

/** 被移除的商品講前三件就夠了；cookie 有大小上限，而清單長到那個地步也沒人讀。 */
export function cartMergeNotice(removedNames: readonly string[]): string | null {
  if (removedNames.length === 0) return null;
  const shown = removedNames.slice(0, 3).join('、');
  const rest = removedNames.length - Math.min(3, removedNames.length);
  return `這些商品已下架，已從購物車移除：${shown}${rest > 0 ? ` 等 ${removedNames.length} 件` : ''}。`;
}

/**
 * 這次請求該用哪一張訪客 token。會員沒有——他們的車綁在身分上，
 * 而登入的那一刻訪客車就併進去了（工單 27）。
 */
export function guestTokenFor(
  req: { actor?: { type: string }; cookies?: Record<string, string | undefined> },
  reply: FastifyReply,
  publicUrl: string,
): string | undefined {
  if (req.actor?.type === 'customer') return undefined;
  return req.cookies?.[CART_COOKIE] ?? setGuestCartCookie(reply, publicUrl);
}

/**
 * 讀取路徑用的：**不簽發**新 token。
 *
 * 讀一次就發一張新 token 等於把「清空購物車」變成一個跨站點得到的開關——
 * `<img src="/cart">` 這種子資源請求不帶 Lax cookie，伺服器卻會回一張新的蓋掉舊的。
 */
export function existingGuestToken(
  req: { actor?: { type: string }; cookies?: Record<string, string | undefined> },
): string | undefined {
  if (req.actor?.type === 'customer') return undefined;
  return req.cookies?.[CART_COOKIE];
}
