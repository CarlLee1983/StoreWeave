import { describe, expect, it, vi } from 'vitest';
import { PlatformError, type Actor } from '@storeweave/contracts';
import { ApiTokenGuard, CSRF_HEADER, SESSION_COOKIE, type AuthenticatedRequest } from '@storeweave/api';
import { csrfTokenFor } from '@storeweave/identity';

/**
 * 三段式守衛（工單 11）：Bearer token → session cookie → 匿名訪客。
 * `@Public()` 的語意是「不需要 token」，不是「一律當訪客」；後者是 `@Anonymous()`。
 */

const sessionActor: Actor = { id: 'user:1', type: 'user', displayName: '店員', permissions: ['catalog:read'] };

function guardWith(options: {
  isPublic?: boolean;
  isAnonymous?: boolean;
  tokenSecret?: string;
  resolveSession?: (token: string) => Promise<{ actor: Actor } | null>;
}) {
  const runtime = {
    config: {
      auth: { tokens: [{ name: 'admin-console', role: 'admin', secretRef: 'TOKEN' }] },
      // 本機 http：cookie 名字沒有 __Host- 前綴（見 cookie-names.ts）。
      http: { publicUrl: 'http://localhost:3000' },
    },
    secrets: { get: (name: string) => (name === 'TOKEN' ? options.tokenSecret ?? 'secret-token' : undefined) },
    auth: { resolveSession: vi.fn(async (_db: unknown, token: string) => (options.resolveSession ? options.resolveSession(token) : null)) },
    database: { db: {} },
  };
  const reflector = {
    getAllAndOverride: (key: string) => (key === 'commerce:public' ? options.isPublic : options.isAnonymous),
  };
  return new ApiTokenGuard(runtime as never, reflector as never);
}

function contextFor(request: AuthenticatedRequest) {
  return { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => null, getClass: () => null } as never;
}

const request = (overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest => ({
  headers: {},
  method: 'GET',
  ...overrides,
});

describe('三段式身分解析', () => {
  it('第一段：Bearer token 勝過一切', async () => {
    const req = request({
      headers: { authorization: 'Bearer secret-token' },
      cookies: { [SESSION_COOKIE]: 'session-token' },
    });
    await guardWith({ resolveSession: async () => ({ actor: sessionActor }) }).canActivate(contextFor(req));

    expect(req.actor!.id).toBe('token:admin-console');
    expect(req.actor!.type).toBe('service');
  });

  it('第二段：沒有 token 時用 session cookie，公開端點也一樣認得出登入者', async () => {
    const req = request({ cookies: { [SESSION_COOKIE]: 'session-token' } });
    await guardWith({ isPublic: true, resolveSession: async () => ({ actor: sessionActor }) }).canActivate(contextFor(req));

    expect(req.actor).toEqual(sessionActor);
  });

  it('第三段：公開端點沒有任何憑證時退回匿名訪客', async () => {
    const req = request();
    await guardWith({ isPublic: true }).canActivate(contextFor(req));

    expect(req.actor!.id).toBe('storefront');
    expect(req.actor!.permissions).toContain('catalog:read');
  });

  it('過期的 cookie 不會讓公開頁面壞掉，退回訪客讓人繼續逛', async () => {
    const req = request({ cookies: { [SESSION_COOKIE]: 'expired' } });
    await guardWith({ isPublic: true, resolveSession: async () => null }).canActivate(contextFor(req));

    expect(req.actor!.id).toBe('storefront');
  });

  it('非公開端點的過期 cookie 仍然是 401', async () => {
    const req = request({ cookies: { [SESSION_COOKIE]: 'expired' } });
    await expect(guardWith({ resolveSession: async () => null }).canActivate(contextFor(req)))
      .rejects.toThrow(PlatformError);
  });

  it('非公開端點沒有任何憑證是 401，不會退回訪客', async () => {
    await expect(guardWith({}).canActivate(contextFor(request()))).rejects.toThrow(/Missing bearer token/);
  });

  it('錯誤的 Bearer token 是 401，不會退而求其次去看 cookie', async () => {
    const req = request({
      headers: { authorization: 'Bearer wrong' },
      cookies: { [SESSION_COOKIE]: 'session-token' },
    });
    await expect(guardWith({ isPublic: true, resolveSession: async () => ({ actor: sessionActor }) }).canActivate(contextFor(req)))
      .rejects.toThrow(/Invalid API token/);
  });
});

describe('@Anonymous() 強制當訪客', () => {
  it('帶著有效 session 也不解析身分', async () => {
    const resolveSession = vi.fn(async () => ({ actor: sessionActor }));
    const req = request({ cookies: { [SESSION_COOKIE]: 'session-token' } });

    await guardWith({ isPublic: true, isAnonymous: true, resolveSession }).canActivate(contextFor(req));

    expect(req.actor!.id).toBe('storefront');
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('寫入請求不必帶 CSRF token——沒有身分就沒有可被冒用的身分', async () => {
    const req = request({ method: 'POST', cookies: { [SESSION_COOKIE]: 'session-token' } });
    await expect(
      guardWith({ isPublic: true, isAnonymous: true, resolveSession: async () => ({ actor: sessionActor }) })
        .canActivate(contextFor(req)),
    ).resolves.toBe(true);
  });
});

describe('CSRF 只擋 cookie 帶進來的寫入', () => {
  const withSession = { isPublic: true, resolveSession: async () => ({ actor: sessionActor }) };

  it('cookie 認證的 POST 缺 CSRF token 被擋', async () => {
    const req = request({ method: 'POST', cookies: { [SESSION_COOKIE]: 'session-token' } });
    await expect(guardWith(withSession).canActivate(contextFor(req))).rejects.toThrow(/CSRF/);
  });

  it('CSRF token 由 session token 推導，正確就放行', async () => {
    const req = request({
      method: 'POST',
      cookies: { [SESSION_COOKIE]: 'session-token' },
      headers: { [CSRF_HEADER]: csrfTokenFor('session-token') },
    });
    await expect(guardWith(withSession).canActivate(contextFor(req))).resolves.toBe(true);
  });

  it('GET 不需要 CSRF token', async () => {
    const req = request({ cookies: { [SESSION_COOKIE]: 'session-token' } });
    await expect(guardWith(withSession).canActivate(contextFor(req))).resolves.toBe(true);
  });
});
