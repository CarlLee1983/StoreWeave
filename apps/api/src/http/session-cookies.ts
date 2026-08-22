import type { FastifyReply } from 'fastify';
import { csrfTokenFor } from '@storeweave/identity';
import { CSRF_COOKIE, SESSION_COOKIE, hostCookie, readCookie } from './cookie-names';
import type { AuthenticatedRequest } from './auth';

export function setSessionCookies(
  reply: FastifyReply,
  options: { publicUrl: string; token: string; expiresAt: Date },
): void {
  const maxAge = Math.max(0, Math.floor((options.expiresAt.getTime() - Date.now()) / 1000));

  const session = hostCookie(SESSION_COOKIE, options.publicUrl, { httpOnly: true, sameSite: 'strict', maxAge });
  reply.setCookie(session.name, options.token, session.options);

  // CSRF cookie 不設 HttpOnly——前端要能讀出來放進 header，做雙提交比對。
  const csrf = hostCookie(CSRF_COOKIE, options.publicUrl, { httpOnly: false, sameSite: 'strict', maxAge });
  reply.setCookie(csrf.name, csrfTokenFor(options.token), csrf.options);
}

export function clearSessionCookies(reply: FastifyReply, publicUrl: string): void {
  const session = hostCookie(SESSION_COOKIE, publicUrl, { httpOnly: true, sameSite: 'strict' });
  reply.clearCookie(session.name, session.options);

  const csrf = hostCookie(CSRF_COOKIE, publicUrl, { httpOnly: false, sameSite: 'strict' });
  reply.clearCookie(csrf.name, csrf.options);
}

/** 這次請求帶來的 session token。名字由 publicUrl 決定，因此每個讀取端都得走這裡。 */
export function sessionTokenOf(req: AuthenticatedRequest | undefined, publicUrl: string): string | undefined {
  return readCookie(req?.cookies, SESSION_COOKIE, publicUrl);
}
