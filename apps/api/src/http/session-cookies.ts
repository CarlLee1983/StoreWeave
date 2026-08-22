import type { FastifyReply } from 'fastify';
import { csrfTokenFor } from '@storeweave/identity';
import { CSRF_COOKIE, SESSION_COOKIE } from './auth';

/**
 * 只有本機開發才允許非 Secure cookie。TLS 由反向代理終止、publicUrl 卻誤寫成 http 時，
 * 用協定推導會讓 session cookie 靜默地以明文傳送。
 */
function secureFor(publicUrl: string): boolean {
  const { protocol, hostname } = new URL(publicUrl);
  return protocol === 'https:' || !['localhost', '127.0.0.1', '::1'].includes(hostname);
}

export function setSessionCookies(
  reply: FastifyReply,
  options: { publicUrl: string; token: string; expiresAt: Date },
): void {
  const maxAge = Math.max(0, Math.floor((options.expiresAt.getTime() - Date.now()) / 1000));
  const secure = secureFor(options.publicUrl);

  reply.setCookie(SESSION_COOKIE, options.token, {
    path: '/', httpOnly: true, sameSite: 'strict', maxAge, secure,
  });
  // CSRF cookie 不設 HttpOnly——前端要能讀出來放進 header，做雙提交比對。
  reply.setCookie(CSRF_COOKIE, csrfTokenFor(options.token), {
    path: '/', httpOnly: false, sameSite: 'strict', maxAge, secure,
  });
}

export function clearSessionCookies(reply: FastifyReply, publicUrl: string): void {
  const secure = secureFor(publicUrl);
  reply.clearCookie(SESSION_COOKIE, { path: '/', sameSite: 'strict', secure, httpOnly: true });
  reply.clearCookie(CSRF_COOKIE, { path: '/', sameSite: 'strict', secure });
}
