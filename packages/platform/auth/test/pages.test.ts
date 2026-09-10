import { describe, expect, it, vi } from 'vitest';
import { PlatformError } from '@storeweave/contracts';
import type { Actor } from '@storeweave/contracts';
import type { AuthenticationPort, PageResolveContext } from '@storeweave/kernel';
import { createAuthPages } from '../src/pages';

const issuedSession = {
  token: 'session-token',
  expiresAt: new Date('2026-09-11T00:00:00Z'),
  user: {
    id: 'u1', email: 'a@example.com', displayName: 'A', role: 'member',
    status: 'active', createdAt: '2026-09-10T00:00:00Z', lastLoginAt: null,
  },
};

const port = (over: Partial<AuthenticationPort> = {}): AuthenticationPort => ({
  authenticate: vi.fn(async () => issuedSession),
  ...over,
});

const pagesWith = (authentication: AuthenticationPort, signedInActorTypes: readonly string[] = ['customer']) =>
  createAuthPages({ authentication: () => authentication, signedInActorTypes });

const visitor = { id: 'anon', type: 'service', permissions: [] } as unknown as Actor;
const customer = { id: 'c1', type: 'customer', permissions: [] } as unknown as Actor;
/** 後台操作者：他在購物站不算「已登入的會員」，所以登入頁要照樣給他表單。 */
const operator = { id: 'u1', type: 'user', permissions: [] } as unknown as Actor;

/** 這些頁面不查資料、不碰 cookie，所以環境只要有 actor 就夠了。 */
const ctx = (actor?: Actor): PageResolveContext => ({
  queries: { execute: vi.fn() },
  commands: { execute: vi.fn() },
  actor,
  locale: 'zh-TW',
} as unknown as PageResolveContext);

describe('登入頁', () => {
  it('未登入時渲染表單，帶著要回去的地方', async () => {
    const outcome = await pagesWith(port()).login.resolve(ctx(visitor), { next: '/account' });

    expect(outcome).toEqual({ kind: 'view', view: { mode: 'login', next: '/account' } });
  });

  it('沒有指定去處時回首頁', async () => {
    const outcome = await pagesWith(port()).login.resolve(ctx(visitor), {});

    expect(outcome).toMatchObject({ kind: 'view', view: { next: '/' } });
  });

  it('已經登入的會員被帶回原本要去的地方，不再看一次表單', async () => {
    const outcome = await pagesWith(port()).login.resolve(ctx(customer), { next: '/account' });

    expect(outcome).toEqual({ kind: 'redirect', location: '/account' });
  });

  it('後台操作者在購物站不算已登入，照樣拿到表單（否則會與會員頁互踢成無限轉址）', async () => {
    const outcome = await pagesWith(port()).login.resolve(ctx(operator), { next: '/account/orders' });

    expect(outcome).toMatchObject({ kind: 'view', view: { mode: 'login' } });
  });

  it('形象站把 member 設成 user 時，同一個 actor 就算已登入', async () => {
    const outcome = await pagesWith(port(), ['user']).login.resolve(ctx(operator), { next: '/me' });

    expect(outcome).toEqual({ kind: 'redirect', location: '/me' });
  });

  it('要回去的地方不能離站，表單裡那一份也一樣', async () => {
    const outcome = await pagesWith(port()).login.resolve(ctx(visitor), { next: 'https://evil.example/steal' });

    expect(outcome).toEqual({ kind: 'view', view: { mode: 'login', next: '/' } });
  });
});

describe('送出登入', () => {
  it('成功時把簽發好的 session 交出去，自己不碰 cookie', async () => {
    const authentication = port();
    const outcome = await pagesWith(authentication).submitLogin.resolve(ctx(visitor), {
      email: 'a@example.com', password: 'a-good-password', next: '/account',
    });

    expect(authentication.authenticate).toHaveBeenCalledWith({ email: 'a@example.com', password: 'a-good-password' });
    expect(outcome).toEqual({ kind: 'session-start', session: issuedSession, location: '/account' });
  });

  it('帳密錯誤回 401 與同一句中性訊息，不說是哪一半錯了', async () => {
    const authentication = port({
      authenticate: vi.fn(async () => { throw new PlatformError('UNAUTHENTICATED', 'Invalid credentials'); }),
    });

    const outcome = await pagesWith(authentication).submitLogin.resolve(ctx(visitor), {
      email: 'nobody@example.com', password: 'wrong',
    });

    expect(outcome).toMatchObject({ kind: 'view', status: 401 });
    expect((outcome as { view: { error?: string } }).view.error).toBe('登入失敗：請確認電子郵件與密碼。');
  });

  it('認證以外的失敗照樣往上拋，不會被當成密碼錯誤吞掉', async () => {
    const authentication = port({
      authenticate: vi.fn(async () => { throw new Error('database is on fire'); }),
    });

    await expect(pagesWith(authentication).submitLogin.resolve(ctx(visitor), {
      email: 'a@example.com', password: 'a-good-password',
    })).rejects.toThrow('database is on fire');
  });
});

describe('登出', () => {
  it('交出 session-clear 與回首頁的去處', async () => {
    const outcome = await pagesWith(port()).logout.resolve(ctx(customer), {});

    expect(outcome).toEqual({ kind: 'session-clear', location: '/' });
  });

  it('沒有畫面，所以不要求 Theme 提供版型', () => {
    expect(pagesWith(port()).logout.required).toBe(false);
  });
});

describe('沒有綁定 port 就使用', () => {
  it('是組裝錯誤，不是使用者的輸入問題', async () => {
    const { createAuthModule } = await import('../src/module');
    const mod = createAuthModule({ signedInActorTypes: ['customer'] });

    // 斷言分類而不只是訊息：400 的訊息會被錯誤頁原樣印給訪客看。
    await expect(mod.pages!.submitLogin.resolve(ctx(visitor), {
      email: 'a@example.com', password: 'x',
    })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});
