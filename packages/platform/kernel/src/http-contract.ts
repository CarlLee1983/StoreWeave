import type { JsonSchema7Type } from 'zod-to-json-schema';

/**
 * 前台頁面的宣告式 HTTP 契約。它跟著頁面宣告走，所以住在 kernel 而不是 apps/api——
 * 模組宣告自己的頁面時要一併宣告契約，不能反過來依賴應用層（ADR 0045）。
 * 啟動時的 route catalog 掃描仍在 apps/api，讀的就是這份形狀。
 */
export type RateLimitBucket = 'auth' | 'coupon' | 'cart' | 'callback';

export interface StorefrontHttpContract {
  readonly kind: 'storefront';
  readonly request: 'none' | 'query' | 'form';
  readonly rateLimit?: RateLimitBucket;
  readonly input: JsonSchema7Type;
  /** HTTP path parameter -> documented caller input name. */
  readonly params?: Readonly<Record<string, string>>;
  /** The handler redirects non-customers; this is not a guard requirement. */
  readonly audience?: 'customer';
  /** An external picker callback is authorized by its opaque token, not a session. */
  readonly auth?: 'opaque-capability';
  readonly responses: readonly StorefrontResponse[];
  readonly cookieEffects?: readonly StorefrontCookieEffect[];
}

export type StorefrontResponse =
  | { readonly kind: 'html'; readonly status: number | 'platform-error'; readonly contentType: 'text/html; charset=utf-8'; readonly body: 'theme' }
  | { readonly kind: 'redirect'; readonly status: 303; readonly location:
    | { readonly kind: 'fixed'; readonly value: string }
    | { readonly kind: 'server-constructed' }
    | { readonly kind: 'validated-same-origin' } };

export type StorefrontCookieEffect = 'session-start' | 'session-clear' | 'guest-cart-ensure' | 'cart-notice-consume';

/** The small release-owned artwork fallback is binary, unlike Theme pages. */
export interface StorefrontAssetHttpContract {
  readonly kind: 'storefront-asset';
  readonly request: 'none';
  readonly input: JsonSchema7Type;
  readonly params: Readonly<Record<string, string>>;
  readonly allowedFiles: readonly string[];
}
