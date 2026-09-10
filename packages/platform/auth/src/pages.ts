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
const htmlOnly: StorefrontHttpContract['responses'] = [html(200), html('platform-error')];

/**
 * 登入頁的畫面資料。工單 98 會把四種認證版型拆成各自獨立的型別；在那之前這個形狀
 * 刻意與 `ThemeAuthView` 的 login 那一支相同，Theme 因此可以沿用同一個渲染函式。
 */
export interface ThemeLoginView {
  readonly mode: 'login';
  /** 完成後要回到哪裡。只接受站內路徑，清洗在路由層（ADR 0047）。 */
  readonly next: string;
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

export interface AuthPageDeps {
  /** 綁定後才拿得到；模組層的 port，不是頁面環境的一部分（ADR 0040、0047）。 */
  readonly authentication: () => AuthenticationPort;
  /** 這個 release 的會員 actor type。購物站是 `['customer']`。 */
  readonly signedInActorTypes: readonly string[];
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
          : { kind: 'view' as const, view: { mode: 'login' as const, next: target } };
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
            return { kind: 'view' as const, status: 401, view: { mode: 'login' as const, next: location, error: FAILED } };
          }
          throw error;
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
