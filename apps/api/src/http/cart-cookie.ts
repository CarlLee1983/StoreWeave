import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import {
  CART_COOKIE, CART_NOTICE_COOKIE, HOST_COOKIE_SCOPE, cookieName, readCookie, secureCookies,
} from './cookie-names';

const CART_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const NOTICE_MAX_AGE = 5 * 60;

export function setGuestCartCookie(reply: FastifyReply, publicUrl: string): string {
  const token = randomBytes(32).toString('base64url');
  reply.setCookie(cookieName(CART_COOKIE, publicUrl), token, {
    ...HOST_COOKIE_SCOPE, httpOnly: true, sameSite: 'lax', secure: secureCookies(publicUrl), maxAge: CART_COOKIE_MAX_AGE,
  });
  return token;
}

/** 併過的 token 立刻失效，留著只會讓下一次請求又去找一台已經作廢的車。 */
export function clearGuestCartCookie(reply: FastifyReply, publicUrl: string): void {
  reply.clearCookie(cookieName(CART_COOKIE, publicUrl), {
    ...HOST_COOKIE_SCOPE, sameSite: 'lax', secure: secureCookies(publicUrl), httpOnly: true,
  });
}

export function setCartNoticeCookie(reply: FastifyReply, publicUrl: string, message: string): void {
  reply.setCookie(cookieName(CART_NOTICE_COOKIE, publicUrl), message, {
    ...HOST_COOKIE_SCOPE, httpOnly: true, sameSite: 'lax', secure: secureCookies(publicUrl), maxAge: NOTICE_MAX_AGE,
  });
}

export function clearCartNoticeCookie(reply: FastifyReply, publicUrl: string): void {
  reply.clearCookie(cookieName(CART_NOTICE_COOKIE, publicUrl), {
    ...HOST_COOKIE_SCOPE, sameSite: 'lax', secure: secureCookies(publicUrl), httpOnly: true,
  });
}

/** 這次請求帶來的合併提示。 */
export function cartNoticeOf(
  req: { cookies?: Record<string, string | undefined> } | undefined,
  publicUrl: string,
): string | undefined {
  return readCookie(req?.cookies, CART_NOTICE_COOKIE, publicUrl);
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
  return readCookie(req.cookies, CART_COOKIE, publicUrl) ?? setGuestCartCookie(reply, publicUrl);
}

/**
 * 讀取路徑用的：**不簽發**新 token。
 *
 * 讀一次就發一張新 token 等於把「清空購物車」變成一個跨站點得到的開關——
 * `<img src="/cart">` 這種子資源請求不帶 Lax cookie，伺服器卻會回一張新的蓋掉舊的。
 */
export function existingGuestToken(
  req: { actor?: { type: string }; cookies?: Record<string, string | undefined> },
  publicUrl: string,
): string | undefined {
  if (req.actor?.type === 'customer') return undefined;
  return readCookie(req.cookies, CART_COOKIE, publicUrl);
}
