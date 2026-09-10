import type { ZodType, ZodTypeAny } from 'zod';
import type { Actor } from '@storeweave/contracts';
import { PlatformError } from '@storeweave/contracts';
import type { PlatformModule } from './module';
import type { StorefrontTheme, ThemeContext } from './theme';

/**
 * 誰看得到這一頁。`public` 未登入也渲染；`customer` 與 `operator` 未登入時導向登入，
 * 登入後還要通過後端授權——隱藏一條路由從來不是權限檢查。
 */
export type PageAudience = 'public' | 'customer' | 'operator';

/**
 * 頁面解析輸入之後的結果。轉址是其中一種結果而不是 renderer 的職責，
 * 寫入頁面因此能走 PRG 而不必讓 Theme 知道 303 這件事。
 */
export type PageOutcome<View> =
  | { readonly kind: 'view'; readonly view: View; readonly status?: number }
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'not-found' };

export interface PageResolveContext {
  readonly queries: { execute<O = unknown>(name: string, input: unknown, options: { actor: Actor }): Promise<O> };
  readonly commands: {
    execute<O = unknown>(name: string, input: unknown, options: { actor: Actor; idempotencyKey?: string }): Promise<O>;
  };
  /** 未登入時是 undefined；`audience` 已經擋掉需要身分卻沒有身分的請求。 */
  readonly actor: Actor | undefined;
  readonly locale: string;
}

/**
 * 一個前台頁面。宣告它的是擁有資料的模組，不是平台——平台只知道「頁面」這個概念，
 * 不知道購物車（ADR 0045）。`resolve` 是原本寫在 storefront controller 裡的那段 handler。
 */
export interface StorefrontPage<Input = unknown, View = unknown> {
  /** 全域唯一，慣例是 `<模組>.<領域>.<動作>`，例如 `commerce.cart.view`。 */
  readonly id: string;
  /** Fastify 形式的 path pattern，例如 `/p/:id`。跨模組衝突在組裝時就報錯。 */
  readonly path: string;
  readonly method: 'get' | 'post';
  readonly audience: PageAudience;
  /** path params 與 query／form 欄位合併之後解析。 */
  readonly input: ZodType<Input>;
  readonly resolve: (ctx: PageResolveContext, input: Input) => Promise<PageOutcome<View>>;
  /** 沿用 B03 的宣告式 HTTP 契約；資料驅動的路由不換掉啟動時的靜態檢查。 */
  readonly contract: unknown;
  /**
   * Theme 沒有實作就拒絕啟動。設 false 代表這一頁沒有畫面（只做寫入與轉址）
   * 或是選配版型，缺了不影響網站可用。
   */
  readonly required?: boolean;
}

export function definePage<Input, View>(page: StorefrontPage<Input, View>): StorefrontPage<Input, View> {
  return page;
}

/** 模組把自己的頁面收成具名 map；型別由此推導出 Theme 該實作哪些 renderer。 */
export type PageMap = Readonly<Record<string, StorefrontPage<any, any>>>;

export type ViewOf<P> = P extends StorefrontPage<any, infer V> ? V : never;

export type PageRenderer<View> = (ctx: ThemeContext, view: View) => string;

export type RenderersFor<Pages extends PageMap> = {
  readonly [K in keyof Pages as ViewOf<Pages[K]> extends never ? never : string]: PageRenderer<ViewOf<Pages[K]>>;
};

/**
 * 依模組註冊順序收集頁面，同時檢查 id 與 path 沒有跨模組衝突。
 * 兩個模組宣告同一條 path 是組裝錯誤：先到先得會讓載入順序決定網站長什麼樣。
 */
export function collectPages(modules: readonly PlatformModule[]): readonly StorefrontPage<any, any>[] {
  const byId = new Map<string, string>();
  const byRoute = new Map<string, string>();
  const pages: StorefrontPage<any, any>[] = [];

  for (const mod of modules) {
    for (const page of Object.values(mod.pages ?? {})) {
      const owner = byId.get(page.id);
      if (owner !== undefined) {
        throw PlatformError.validation(`頁面 id '${page.id}' 同時由模組 '${owner}' 與 '${mod.name}' 宣告`);
      }
      const route = `${page.method} ${page.path}`;
      const routeOwner = byRoute.get(route);
      if (routeOwner !== undefined) {
        throw PlatformError.validation(
          `路由 ${page.method.toUpperCase()} '${page.path}' 同時由模組 '${routeOwner}' 與 '${mod.name}' 宣告`,
        );
      }
      byId.set(page.id, mod.name);
      byRoute.set(route, mod.name);
      pages.push(page);
    }
  }

  return pages;
}

/**
 * 在開始服務之前比對已載入模組宣告的必需頁面與 Theme 提供的 renderer。
 * 缺頁在啟動時拒絕，不留到某位客人按下結帳的那一刻才變成 404（ADR 0045）。
 */
export function assertThemeCoversPages(modules: readonly PlatformModule[], theme: StorefrontTheme): void {
  const missing = collectPages(modules)
    .filter(page => page.required !== false && !(page.id in theme.renderers))
    .map(page => page.id);

  if (missing.length > 0) {
    throw PlatformError.validation(
      `Theme '${theme.id}' 缺少 ${missing.length} 個必需頁面：${missing.join('、')}`,
    );
  }
}

export type { ZodTypeAny };
