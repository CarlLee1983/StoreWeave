import { z } from 'zod';
import type { ZodType, ZodTypeAny, ZodTypeDef } from 'zod';
import type { Actor } from '@storeweave/contracts';
import { PlatformError } from '@storeweave/contracts';
import type { StorefrontHttpContract } from './http-contract';
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

/**
 * 頁面能碰的 cookie，就只有這幾件事。給的是具名動作而不是 FastifyReply：
 * 契約裡的 `cookieEffects` 因此仍然說得準，模組也不能順手寫別的 cookie。
 */
export interface PageCookiePort {
  /** 訪客購物車 token；已登入或還沒有車時是 null。 */
  readonly guestCartToken: () => string | null;
  /** 確保訪客有一個購物車 token，必要時簽發並寫進回應。 */
  readonly ensureGuestCart: () => string;
}

/**
 * Provider registry 的唯讀入口。結帳頁要列出付款方式、取貨頁要問物流商有哪些門市，
 * 這些是 extension 提供的能力，沒有等價的查詢可以取代。
 */
export interface PageProviderPort {
  readonly get: <T>(kind: string, id?: string) => T;
  /** 有沒有註冊這種 provider。結帳頁靠它決定要不要顯示發票欄位。 */
  readonly has: (kind: string, id?: string) => boolean;
}

export interface PageResolveContext {
  readonly queries: { execute<O = unknown>(name: string, input: unknown, options: { actor: Actor }): Promise<O> };
  readonly commands: {
    execute<O = unknown>(
      name: string, input: unknown,
      /** `correlationId` 讓一次操作在稽核紀錄裡串得起來；寫入命令應該帶。 */
      options: { actor: Actor; idempotencyKey?: string; correlationId?: string },
    ): Promise<O>;
  };
  /**
   * 永遠存在：未登入時是該 release 的匿名 actor。查詢與命令一律帶身分，
   * 範圍過濾因此留在 handler 那一層，頁面不必自己加條件。
   */
  readonly actor: Actor;
  readonly locale: string;
  /**
   * 這個請求的來源端識別，由路由層算出——匿名訪客彼此不同，但不是原始位址。
   * 表單節流這種「同一個人短時間內做太多次」的判斷用它當鍵；用 actor.id 會讓
   * 所有匿名訪客共用一個視窗，第一個灌爆的人就把其他人一起擋掉。
   */
  readonly clientKey: string;
  readonly cookies: PageCookiePort;
  readonly providers: PageProviderPort;
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
  /**
   * path params 與 query／form 欄位合併之後解析。輸入端一律是字串，所以 schema
   * 可以帶 transform——`Input` 指的是 transform 之後 `resolve` 收到的形狀。
   */
  readonly input: ZodType<Input, ZodTypeDef, any>;
  readonly resolve: (ctx: PageResolveContext, input: Input) => Promise<PageOutcome<View>>;
  /** 沿用 B03 的宣告式 HTTP 契約；資料驅動的路由不換掉啟動時的靜態檢查。 */
  readonly contract: StorefrontHttpContract;
  /**
   * 未登入時導向登入頁後要回到哪裡。預設是這一頁自己，但寫入頁面通常要回到它的
   * 顯示頁——送出折抵失敗後把人丟回 `POST /cart/rewards` 沒有意義。收到的是原始
   * path params，因為這個判斷發生在解析輸入之前。
   */
  readonly loginNext?: (params: Record<string, string | undefined>) => string;
  /**
   * Theme 沒有實作就拒絕啟動。設 false 代表這一頁沒有畫面（只做寫入與轉址）
   * 或是選配版型，缺了不影響網站可用。
   */
  readonly required?: boolean;
}

/**
 * 前台表單送出的一律是字串，但直接打 JSON 的呼叫端（整合測試、腳本）會送原生型別。
 * 兩者都接受並一律當字串處理，頁面的輸入 schema 因此不必各自處理這件事——
 * 只收字串的 schema 會把一個合法的請求變成 500。
 */
export const formValue = z.union([z.string(), z.number(), z.boolean()]).transform(String);

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
 * 沒有自己的路由，但任何 release 都會用到的頁面。錯誤頁是別條路由失敗時的結果，
 * 所以不由誰「宣告」，而是每個 Theme 都必須提供。
 *
 * 登入表單暫時也在這裡：它的寫入端點要簽發 session cookie，而頁面能碰的 cookie
 * 只有訪客購物車那兩個動作。identity 的頁面遷移（B13 片5）會把它改成模組宣告，
 * 屆時這個清單應該只剩錯誤頁。
 */
export const SYSTEM_PAGE_IDS = ['platform.error', 'platform.auth'] as const;

/**
 * 在開始服務之前比對已載入模組宣告的必需頁面與 Theme 提供的 renderer。
 * 缺頁在啟動時拒絕，不留到某位客人按下結帳的那一刻才變成 404（ADR 0045）。
 */
export function assertThemeCoversPages(modules: readonly PlatformModule[], theme: StorefrontTheme): void {
  const missing = [
    ...SYSTEM_PAGE_IDS.filter(id => !(id in theme.renderers)),
    ...collectPages(modules)
      .filter(page => page.required !== false && !(page.id in theme.renderers))
      .map(page => page.id),
  ];

  if (missing.length > 0) {
    throw PlatformError.validation(
      `Theme '${theme.id}' 缺少 ${missing.length} 個必需頁面：${missing.join('、')}`,
    );
  }
}

export type { ZodTypeAny };
