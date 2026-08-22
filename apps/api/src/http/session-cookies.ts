import type { FastifyReply } from 'fastify';
import { csrfTokenFor } from '@storeweave/identity';
import {
  CSRF_COOKIE, HOST_COOKIE_SCOPE, SESSION_COOKIE, cookieName, readCookie, secureCookies,
} from './cookie-names';
import type { AuthenticatedRequest } from './auth';

export function setSessionCookies(
  reply: FastifyReply,
  options: { publicUrl: string; token: string; expiresAt: Date },
): void {
  const maxAge = Math.max(0, Math.floor((options.expiresAt.getTime() - Date.now()) / 1000));
  const secure = secureCookies(options.publicUrl);

  reply.setCookie(cookieName(SESSION_COOKIE, options.publicUrl), options.token, {
    ...HOST_COOKIE_SCOPE, httpOnly: true, sameSite: 'strict', maxAge, secure,
  });
  // CSRF cookie 不設 HttpOnly——前端要能讀出來放進 header，做雙提交比對。
  reply.setCookie(cookieName(CSRF_COOKIE, options.publicUrl), csrfTokenFor(options.token), {
    ...HOST_COOKIE_SCOPE, httpOnly: false, sameSite: 'strict', maxAge, secure,
  });
}

export function clearSessionCookies(reply: FastifyReply, publicUrl: string): void {
  const secure = secureCookies(publicUrl);
  reply.clearCookie(cookieName(SESSION_COOKIE, publicUrl), {
    ...HOST_COOKIE_SCOPE, sameSite: 'strict', secure, httpOnly: true,
  });
  reply.clearCookie(cookieName(CSRF_COOKIE, publicUrl), { ...HOST_COOKIE_SCOPE, sameSite: 'strict', secure });
}

/** 這次請求帶來的 session token。名字由 publicUrl 決定，因此每個讀取端都得走這裡。 */
export function sessionTokenOf(req: AuthenticatedRequest | undefined, publicUrl: string): string | undefined {
  return readCookie(req?.cookies, SESSION_COOKIE, publicUrl);
}
