import { z } from 'zod';
import { PlatformError } from '@storeweave/contracts';
import { definePage, formValue, safeRedirectPath, type AuthenticationPort, type StorefrontHttpContract } from '@storeweave/kernel';
import type { JsonSchema7Type } from 'zod-to-json-schema';

const jsonSchema = (fields: readonly string[]): JsonSchema7Type => ({
  type: 'object',
  properties: Object.fromEntries(fields.map(field => [field, { type: 'string' }])),
  additionalProperties: true,
} as JsonSchema7Type);

const html = (status: number | 'platform-error'): StorefrontHttpContract['responses'][number] =>
  ({ kind: 'html', status, contentType: 'text/html; charset=utf-8', body: 'theme' });
// 生成的 controller 對每一頁都掛了錯誤頁，所以每個宣告 HTML 的頁面都要宣告它。
const htmlOnly: StorefrontHttpContract['responses'] = [html(200), html('platform-error')];

/** 重設連結的時效。夠久到收得到信，短到外洩的信件不會長期有效。 */
const RESET_TTL_MS = 60 * 60 * 1000;
const PASSWORD_RESET_NOTICE = '若這個電子郵件存在，我們已經把重設連結寄出去了。';
const PASSWORD_RESET_FAILED = '設定新密碼失敗，請重新申請一次。';

/**
 * 登入頁的畫面資料。四種認證版型各有自己的型別而不是一個四模式的聯集：`token`
 * 只對重設密碼有意義，`notice` 只對忘記密碼有意義，攤在同一個型別裡會讓每個
 * renderer 都得自己記住哪一支該讀哪個欄位（ADR 0047）。`mode` 留著當渲染時的
 * 標題與表單 action 依據，不再是分辨型別的判別欄位。
 */
export interface ThemeLoginView {
  readonly mode: 'login';
  /** 完成後要回到哪裡。只接受站內路徑，清洗在路由層（ADR 0047）。 */
  readonly next: string;
  readonly error?: string;
  /** 上一次填的信箱。失敗後重新渲染時放回欄位，人不必把它重打一次。 */
  readonly email?: string;
}

/** 忘記密碼只會成功——回應對存在與不存在的信箱一致，所以沒有 `error`。 */
export interface ThemeForgotPasswordView {
  readonly mode: 'forgot-password';
  readonly next: string;
  readonly notice?: string;
}

export interface ThemeResetPasswordView {
  readonly mode: 'reset-password';
  readonly next: string;
  readonly token: string;
  readonly error?: string;
}

/**
 * 帳密錯誤、帳號不存在、帳號停用一律是同一句話。分開講就是一個帳號枚舉的管道，
 * 而 `AuthService.authenticate` 連耗時都刻意對齊了。
 */
const FAILED = '登入失敗：請確認電子郵件與密碼。';

/**
 * 哪一種 actor 算是「這個網站的已登入會員」由 release 決定：購物站是 customer，
 * 形象站的 member 是 user。寫死成兩者皆可會讓營運者逛前台時被判成已登入，
 * 於是在登入頁與會員頁之間互踢（工單 94 的 review）。
 */
const signedIn = (types: readonly string[], type: string | undefined): boolean =>
  type !== undefined && types.includes(type);

/** 註冊頁的畫面資料。 */
export interface ThemeRegisterView {
  readonly mode: 'register';
  /** 註冊完成後要回到哪裡。只接受站內路徑，清洗在路由層（ADR 0047）。 */
  readonly next: string;
  readonly error?: string;
}

export interface AuthPageDeps {
  /** 綁定後才拿得到；模組層的 port，不是頁面環境的一部分（ADR 0040、0047）。 */
  readonly authentication: () => AuthenticationPort;
  /** 重設信寄送失敗仍須記錄，但不能改變對外中性回應。 */
  readonly logPasswordResetFailure: (error: unknown) => void;
  /** 這個 release 的會員 actor type。購物站是 `['customer']`。 */
  readonly signedInActorTypes: readonly string[];
  /**
   * 註冊命令由組裝的 release 選擇：購物站傳建立 Customer 的那一個（它在同一筆交易裡建立
   * Account 與 Customer）；沒有命令的形象站改用 identity 自助建立 Account。認證模組自己
   * 不知道這個網站的會員除了帳號之外還有什麼（ADR 0041、0047）。
   */
  readonly registerCommand?: string;
}

/** 顯示名稱沒填就交給命令自己從信箱推導；空白字串會變成一個沒有名字的名字。 */
const displayNameOf = (value: string | undefined): string | undefined => value?.trim() || undefined;

/** 已存在的帳號**不能**在這裡說出來——那是一條比登入更明確的帳號枚舉管道。 */
const REGISTER_CONFLICT = '無法用這組資料註冊。如果你已經有帳號，請改用登入或密碼重設。';
/**
 * 欄位不合規。不轉述原始訊息：註冊命令的輸入由 command bus 解析，它的驗證錯誤長成
 * `Invalid input for "commerce.customer.registerCustomer"`——對訪客沒有意義，卻把內部
 * 命令名印出去。長度下限屬於 release 的政策，所以這句話不寫死數字。
 */
const REGISTER_INVALID = '註冊失敗：請確認電子郵件格式與密碼長度。';
const REGISTER_REFUSED = '目前無法用這個身分註冊。如果你已經登入，請先登出。';

/**
 * 註冊失敗要回哪一句話，或者「這不是使用者的問題，往上拋」。
 *
 * 逐一分類而不是「4xx 就原樣轉述」：遷移前這裡的身分永遠是匿名訪客，現在是這個請求的
 * 身分，於是多出一種 4xx——已登入的顧客沒有 `customer:register`，拿到的是 FORBIDDEN，
 * 原樣印出去等於把權限鍵給訪客看。剩下的（資料庫故障、命令不存在）不編成 400：
 * 那會讓註冊在故障期間安靜地失敗，log 與監控都拿不到訊號（工單 95 的 review）。
 */
function registerFailure(error: unknown): string | undefined {
  if (!(error instanceof PlatformError)) return undefined;
  switch (error.code) {
    case 'CONFLICT': return REGISTER_CONFLICT;
    case 'VALIDATION_ERROR': return REGISTER_INVALID;
    case 'FORBIDDEN': return REGISTER_REFUSED;
    default: return undefined;
  }
}

export function createAuthPages(deps: AuthPageDeps) {
  return {
    login: definePage({
      id: 'platform.auth.login',
      path: '/login',
      method: 'get',
      audience: 'public',
      input: z.object({ next: formValue.optional() }),
      contract: {
        kind: 'storefront', request: 'query', input: jsonSchema(['next']),
        // 已登入者會被轉走，所以契約上要看得見這條路，不能只宣告 HTML。
        responses: [...htmlOnly, { kind: 'redirect', status: 303, location: { kind: 'validated-same-origin' } }],
      },
      resolve: async (ctx, { next }) => {
        // 表單裡那個回程路徑會原樣送回來，所以它和轉址目的地是同一件事，用同一份清洗。
        const target = safeRedirectPath(next);
        // 已經登入的人不必再看一次表單——重新渲染會讓人以為自己被登出了。
        return signedIn(deps.signedInActorTypes, ctx.actor?.type)
          ? { kind: 'redirect' as const, location: target }
          : { kind: 'view' as const, view: { mode: 'login', next: target } satisfies ThemeLoginView };
      },
    }),

    submitLogin: definePage({
      id: 'platform.auth.submitLogin',
      path: '/login',
      method: 'post',
      audience: 'public',
      input: z.object({
        email: formValue,
        password: formValue,
        next: formValue.optional(),
      }),
      contract: {
        kind: 'storefront', request: 'form', rateLimit: 'auth',
        input: jsonSchema(['email', 'password', 'next']),
        responses: [html(401), html('platform-error'), { kind: 'redirect', status: 303, location: { kind: 'validated-same-origin' } }],
        cookieEffects: ['session-start'],
      },
      resolve: async (_ctx, { email, password, next }) => {
        const location = safeRedirectPath(next);
        try {
          const session = await deps.authentication().authenticate({ email, password });
          return { kind: 'session-start' as const, session, location };
        } catch (error) {
          // 認證失敗是輸入問題，不是伺服器故障：回到表單並保留信箱，不洩漏是哪一半錯了。
          if (error instanceof PlatformError && error.code === 'UNAUTHENTICATED') {
            return {
              kind: 'view' as const, status: 401,
              view: { mode: 'login', next: location, error: FAILED, email } satisfies ThemeLoginView,
            };
          }
          throw error;
        }
      },
    }),

    forgotPassword: definePage({
      id: 'platform.auth.forgotPassword',
      path: '/forgot-password',
      method: 'get',
      audience: 'public',
      input: z.object({}),
      contract: {
        kind: 'storefront', request: 'none', input: jsonSchema([]), responses: htmlOnly,
      },
      resolve: async () => ({
        kind: 'view' as const,
        view: { mode: 'forgot-password', next: '/' } satisfies ThemeForgotPasswordView,
      }),
    }),

    submitForgotPassword: definePage({
      id: 'platform.auth.submitForgotPassword',
      path: '/forgot-password',
      method: 'post',
      audience: 'public',
      input: z.object({ email: formValue }),
      contract: {
        kind: 'storefront', request: 'form', rateLimit: 'auth', input: jsonSchema(['email']), responses: htmlOnly,
      },
      resolve: async (_ctx, { email }) => {
        try {
          await deps.authentication().requestPasswordReset({ email, ttlMs: RESET_TTL_MS });
        } catch (error) {
          // 有沒有寄成功不能變成帳號是否存在的訊號；失敗只留在營運 log。
          deps.logPasswordResetFailure(error);
        }
        return {
          kind: 'view' as const,
          view: { mode: 'forgot-password', next: '/', notice: PASSWORD_RESET_NOTICE } satisfies ThemeForgotPasswordView,
        };
      },
    }),

    resetPassword: definePage({
      id: 'platform.auth.resetPassword',
      path: '/reset-password',
      method: 'get',
      audience: 'public',
      input: z.object({ token: formValue.optional() }),
      contract: {
        kind: 'storefront', request: 'query', input: jsonSchema(['token']), responses: htmlOnly,
      },
      resolve: async (_ctx, { token }) => ({
        kind: 'view' as const,
        view: { mode: 'reset-password', next: '/', token: token ?? '' } satisfies ThemeResetPasswordView,
      }),
    }),

    submitResetPassword: definePage({
      id: 'platform.auth.submitResetPassword',
      path: '/reset-password',
      method: 'post',
      audience: 'public',
      input: z.object({ token: formValue, password: formValue }),
      contract: {
        kind: 'storefront', request: 'form', rateLimit: 'auth', input: jsonSchema(['token', 'password']),
        responses: [html(400), { kind: 'redirect', status: 303, location: { kind: 'fixed', value: '/login' } }],
      },
      resolve: async (_ctx, { token, password }) => {
        try {
          await deps.authentication().resetPassword({ token, newPassword: password });
          return { kind: 'redirect' as const, location: '/login' };
        } catch (error) {
          const message = error instanceof PlatformError && error.httpStatus < 500 ? error.message : PASSWORD_RESET_FAILED;
          return {
            kind: 'view' as const,
            status: 400,
            view: { mode: 'reset-password', next: '/', token, error: message } satisfies ThemeResetPasswordView,
          };
        }
      },
    }),

    register: definePage({
      id: 'platform.auth.register',
      path: '/register',
      method: 'get',
      audience: 'public',
      input: z.object({ next: formValue.optional() }),
      contract: {
        kind: 'storefront', request: 'query', input: jsonSchema(['next']),
        // 已登入者會被轉走，所以契約上要看得見這條路。
        responses: [...htmlOnly, { kind: 'redirect', status: 303, location: { kind: 'validated-same-origin' } }],
      },
      resolve: async (ctx, { next }) => {
        const target = safeRedirectPath(next);
        // 和登入頁同一個判斷：已經是這個網站的會員了，再給他一張註冊表單只會讓他填出
        // 一個註冊不成功的表單（他沒有 `customer:register`）。
        return signedIn(deps.signedInActorTypes, ctx.actor?.type)
          ? { kind: 'redirect' as const, location: target }
          : { kind: 'view' as const, view: { mode: 'register', next: target } satisfies ThemeRegisterView };
      },
    }),

    submitRegister: definePage({
      id: 'platform.auth.submitRegister',
      path: '/register',
      method: 'post',
      audience: 'public',
      input: z.object({
        email: formValue,
        password: formValue,
        displayName: formValue.optional(),
        next: formValue.optional(),
      }),
      contract: {
        kind: 'storefront', request: 'form', rateLimit: 'auth',
        input: jsonSchema(['email', 'password', 'displayName', 'next']),
        responses: [html(400), html('platform-error'), { kind: 'redirect', status: 303, location: { kind: 'validated-same-origin' } }],
        cookieEffects: ['session-start'],
      },
      resolve: async (ctx, { email, password, displayName, next }) => {
        const location = safeRedirectPath(next);
        try {
          const registration = { email, password, displayName: displayNameOf(displayName) };
          // Commerce 的 command 在同一筆交易裡還會建立 Customer；Base 沒有那個領域資料，
          // 所以直接由 identity 建立 Account 並取用它剛簽發的 session。
          let session;
          if (deps.registerCommand !== undefined) {
            await ctx.commands.execute(deps.registerCommand, registration, { actor: ctx.actor });
            session = await deps.authentication().authenticate({ email, password });
          } else {
            session = await deps.authentication().register(registration);
          }
          return { kind: 'session-start' as const, session, location };
        } catch (error) {
          const message = registerFailure(error);
          // 分不出類別的失敗交給錯誤頁：它會記 5xx 並對外只說「發生未預期的錯誤」。
          if (message === undefined) throw error;
          return {
            kind: 'view' as const, status: 400,
            view: { mode: 'register', next: location, error: message } satisfies ThemeRegisterView,
          };
        }
      },
    }),

    logout: definePage({
      id: 'platform.auth.logout',
      path: '/logout',
      method: 'post',
      audience: 'public',
      input: z.object({}),
      contract: {
        kind: 'storefront', request: 'none', input: jsonSchema([]),
        // 清除失敗時路由層會走錯誤頁，所以 HTML 那條也要宣告。
        responses: [html('platform-error'), { kind: 'redirect', status: 303, location: { kind: 'fixed', value: '/' } }],
        cookieEffects: ['session-clear'],
      },
      // 只轉址、沒有畫面，所以不要求 Theme 提供版型。
      required: false,
      resolve: async () => ({ kind: 'session-clear' as const, location: '/' }),
    }),
  } as const;
}

export type AuthPages = ReturnType<typeof createAuthPages>;
