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
  register: vi.fn(async () => issuedSession),
  requestPasswordReset: vi.fn(async () => undefined),
  resetPassword: vi.fn(async () => undefined),
  ...over,
});

const REGISTER_COMMAND = 'commerce.customer.registerCustomer';

const pagesWith = (
  authentication: AuthenticationPort,
  signedInActorTypes: readonly string[] = ['customer'],
  logPasswordResetFailure = vi.fn(),
) => createAuthPages({
  authentication: () => authentication,
  signedInActorTypes,
  registerCommand: REGISTER_COMMAND,
  logPasswordResetFailure,
});

const basePagesWith = (authentication: AuthenticationPort) => createAuthPages({
  authentication: () => authentication,
  signedInActorTypes: ['user'],
  logPasswordResetFailure: vi.fn(),
});

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

  it('帳密錯誤時把填過的信箱放回表單，人不必重打一次', async () => {
    const authentication = port({
      authenticate: vi.fn(async () => { throw new PlatformError('UNAUTHENTICATED', 'Invalid credentials'); }),
    });

    const outcome = await pagesWith(authentication).submitLogin.resolve(ctx(visitor), {
      email: 'someone@example.com', password: 'wrong',
    });

    expect(outcome).toMatchObject({ kind: 'view', view: { email: 'someone@example.com' } });
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

describe('忘記密碼', () => {
  it('顯示忘記密碼表單', async () => {
    const outcome = await pagesWith(port()).forgotPassword.resolve(ctx(visitor), {});

    expect(outcome).toEqual({ kind: 'view', view: { mode: 'forgot-password', next: '/' } });
  });

  it('無論寄信是否成功都顯示同一句中性訊息，失敗交給 log', async () => {
    const requestPasswordReset = vi.fn(async () => { throw new Error('mail queue unavailable'); });
    const authentication = port({ requestPasswordReset });
    const logPasswordResetFailure = vi.fn();

    const outcome = await pagesWith(authentication, ['customer'], logPasswordResetFailure).submitForgotPassword.resolve(ctx(visitor), {
      email: 'nobody@example.com',
    });

    expect(requestPasswordReset).toHaveBeenCalledWith({ email: 'nobody@example.com', ttlMs: 60 * 60 * 1000 });
    expect(outcome).toEqual({
      kind: 'view',
      view: { mode: 'forgot-password', next: '/', notice: '若這個電子郵件存在，我們已經把重設連結寄出去了。' },
    });
    expect(logPasswordResetFailure).toHaveBeenCalledWith(expect.any(Error));
    expect(pagesWith(port()).submitForgotPassword.contract.rateLimit).toBe('auth');
  });
});

describe('重設密碼', () => {
  it('把連結裡的 token 帶到表單', async () => {
    const outcome = await pagesWith(port()).resetPassword.resolve(ctx(visitor), { token: 'signed-token' });

    expect(outcome).toEqual({ kind: 'view', view: { mode: 'reset-password', next: '/', token: 'signed-token' } });
  });

  it('成功後帶回登入頁', async () => {
    const resetPassword = vi.fn(async () => undefined);
    const outcome = await pagesWith(port({ resetPassword })).submitResetPassword.resolve(ctx(visitor), {
      token: 'signed-token', password: 'brand-new-password',
    });

    expect(resetPassword).toHaveBeenCalledWith({ token: 'signed-token', newPassword: 'brand-new-password' });
    expect(outcome).toEqual({ kind: 'redirect', location: '/login' });
    expect(pagesWith(port()).submitResetPassword.contract.rateLimit).toBe('auth');
  });

  it('無效 token 維持 400 與原本的錯誤訊息', async () => {
    const resetPassword = vi.fn(async () => { throw PlatformError.validation('This reset link is invalid or has expired'); });
    const outcome = await pagesWith(port({ resetPassword })).submitResetPassword.resolve(ctx(visitor), {
      token: 'expired-token', password: 'brand-new-password',
    });

    expect(outcome).toEqual({
      kind: 'view', status: 400,
      view: {
        mode: 'reset-password', next: '/', token: 'expired-token',
        error: 'This reset link is invalid or has expired',
      },
    });
  });
});

describe('沒有綁定 port 就使用', () => {
  it('是組裝錯誤，不是使用者的輸入問題', async () => {
    const { createAuthModule } = await import('../src/module');
    const mod = createAuthModule({ signedInActorTypes: ['customer'], registerCommand: REGISTER_COMMAND });

    // 斷言分類而不只是訊息：400 的訊息會被錯誤頁原樣印給訪客看。
    await expect(mod.pages!.submitLogin.resolve(ctx(visitor), {
      email: 'a@example.com', password: 'x',
    })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('拒絕空白註冊命令，避免自訂 release 靜默退回 Account-only 註冊', async () => {
    const { createAuthModule } = await import('../src/module');

    expect(() => createAuthModule({ signedInActorTypes: ['customer'], registerCommand: '  ' }))
      .toThrow('registerCommand must be non-empty');
  });
});

describe('註冊頁', () => {
  it('渲染表單，帶著要回去的地方', async () => {
    const outcome = await pagesWith(port()).register.resolve(ctx(visitor), { next: '/cart' });

    expect(outcome).toEqual({ kind: 'view', view: { mode: 'register', next: '/cart' } });
  });

  it('要回去的地方不能離站，表單裡那一份也一樣', async () => {
    const outcome = await pagesWith(port()).register.resolve(ctx(visitor), { next: '//evil.example' });

    expect(outcome).toEqual({ kind: 'view', view: { mode: 'register', next: '/' } });
  });

  it('已經是會員的人被帶回原本要去的地方，不再拿到一張註冊不成功的表單', async () => {
    const outcome = await pagesWith(port()).register.resolve(ctx(customer), { next: '/account' });

    expect(outcome).toEqual({ kind: 'redirect', location: '/account' });
  });

  it('後台操作者在購物站不算會員，照樣拿到表單', async () => {
    const outcome = await pagesWith(port()).register.resolve(ctx(operator), { next: '/' });

    expect(outcome).toMatchObject({ kind: 'view', view: { mode: 'register' } });
  });
});

describe('送出註冊', () => {
  /** 命令會被拒絕的那幾個案例都要換掉 execute，所以 context 由呼叫端自己給。 */
  const submit = (
    context: PageResolveContext,
    input: { email: string; password: string; displayName?: string; next?: string },
    authentication: AuthenticationPort = port(),
  ) => pagesWith(authentication).submitRegister.resolve(context, input);

  it('跑 release 指定的那一個註冊命令，帶著這次請求的身分', async () => {
    const context = ctx(visitor);
    await submit(context, { email: 'a@example.com', password: 'a-good-password', displayName: '小明' });

    expect(context.commands.execute).toHaveBeenCalledWith(
      REGISTER_COMMAND,
      { email: 'a@example.com', password: 'a-good-password', displayName: '小明' },
      { actor: visitor },
    );
  });

  it('註冊完成即登入：交出簽發好的 session 與站內的去處，自己不碰 cookie', async () => {
    const authentication = port();
    const outcome = await submit(ctx(visitor), {
      email: 'a@example.com', password: 'a-good-password', next: '/checkout',
    }, authentication);

    expect(authentication.authenticate).toHaveBeenCalledWith({ email: 'a@example.com', password: 'a-good-password' });
    expect(outcome).toEqual({ kind: 'session-start', session: issuedSession, location: '/checkout' });
  });

  it('沒有 release 註冊命令時，交給 identity 的自助註冊並直接使用它簽發的 session', async () => {
    const authentication = port();
    const context = ctx(visitor);
    const outcome = await basePagesWith(authentication).submitRegister.resolve(context, {
      email: 'member@example.com', password: 'a-good-password', displayName: '會員', next: '/welcome',
    });

    expect(authentication.register).toHaveBeenCalledWith({
      email: 'member@example.com', password: 'a-good-password', displayName: '會員',
    });
    expect(context.commands.execute).not.toHaveBeenCalled();
    expect(authentication.authenticate).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'session-start', session: issuedSession, location: '/welcome' });
  });

  it('註冊完的去處一樣不能離站', async () => {
    const outcome = await submit(ctx(visitor), {
      email: 'a@example.com', password: 'a-good-password', next: 'https://evil.example',
    });

    expect(outcome).toMatchObject({ kind: 'session-start', location: '/' });
  });

  it('空白的顯示名稱當成沒填，不會變成一個空字串的名字', async () => {
    const context = ctx(visitor);
    await submit(context, { email: 'a@example.com', password: 'a-good-password', displayName: '   ' });

    expect(context.commands.execute).toHaveBeenCalledWith(
      REGISTER_COMMAND,
      { email: 'a@example.com', password: 'a-good-password', displayName: undefined },
      { actor: visitor },
    );
  });

  it('信箱已存在時回中性訊息，不成為帳號枚舉的管道', async () => {
    const context = ctx(visitor);
    (context.commands.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new PlatformError('CONFLICT', 'Account with email a@example.com already exists'),
    );

    const outcome = await submit(context, { email: 'a@example.com', password: 'a-good-password' });

    expect(outcome).toMatchObject({ kind: 'view', status: 400, view: { mode: 'register' } });
    const { view } = outcome as { view: { error?: string } };
    expect(view.error).toBe('無法用這組資料註冊。如果你已經有帳號，請改用登入或密碼重設。');
    expect(view.error).not.toContain('a@example.com');
  });

  it('欄位不合規回自己的一句話，不轉述 command bus 那句帶命令名的訊息', async () => {
    const context = ctx(visitor);
    // 這正是 command bus 對 zod 失敗產生的訊息形狀。
    (context.commands.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      PlatformError.validation('Invalid input for "commerce.customer.registerCustomer"'),
    );

    const outcome = await submit(context, { email: 'a@example.com', password: 'x' });

    expect(outcome).toMatchObject({
      kind: 'view', status: 400,
      view: { mode: 'register', error: '註冊失敗：請確認電子郵件格式與密碼長度。' },
    });
    expect(JSON.stringify(outcome)).not.toContain('commerce.customer.registerCustomer');
  });

  it('沒有註冊權限時回中性訊息，不能把權限鍵印給他看', async () => {
    const context = ctx(customer);
    (context.commands.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      PlatformError.forbidden("Actor lacks permission 'customer:register'"),
    );

    const outcome = await submit(context, { email: 'a@example.com', password: 'a-good-password' });

    expect(outcome).toMatchObject({ kind: 'view', status: 400, view: { mode: 'register' } });
    expect(JSON.stringify(outcome)).not.toContain('customer:register');
  });

  it('分不出類別的失敗往上拋，不編成一個 400 的註冊表單', async () => {
    const context = ctx(visitor);
    (context.commands.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('database is on fire'));

    // 安靜地回 400 等於註冊在故障期間失敗而 log 與監控都收不到訊號。
    await expect(submit(context, { email: 'a@example.com', password: 'a-good-password' }))
      .rejects.toThrow('database is on fire');
  });

  it('契約上看得見它會簽發 session，也看得見它受節流', () => {
    const { submitRegister } = pagesWith(port());

    expect(submitRegister.contract.cookieEffects).toEqual(['session-start']);
    expect(submitRegister.contract.rateLimit).toBe('auth');
  });
});
