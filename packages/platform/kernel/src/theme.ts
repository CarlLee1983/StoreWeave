import type { ZodTypeAny } from 'zod';

export interface ThemeProductView {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  available: number | null;
}

export interface ThemeOrderView {
  number: string;
  status: string;
  currency: string;
  totalCents: number;
  customerEmail: string;
  lines: { sku: string; name: string; quantity: number; lineTotalCents: number }[];
}

export interface ThemeAuthView {
  mode: 'login' | 'register';
  /** 完成後要回到哪裡。只接受站內路徑。 */
  next: string;
  error?: string;
}

export interface ThemeContext {
  storeName: string;
  storeId: string;
  currency: string;
  locale: string;
  publicUrl: string;
  supportEmail?: string;
  /** 由 commerce.yaml 的 theme.options 提供，已通過 optionsSchema 驗證。 */
  options: Record<string, unknown>;
  /** 已登入時的顯示名稱；未登入為 null。 */
  customerName?: string | null;
  /** 登入者的 CSRF token。寫入表單必須把它放進隱藏欄位 `_csrf`。 */
  csrfToken?: string | null;
}

/**
 * Storefront Theme 契約。
 * 品牌差異全部落在這裡 —— Core 不會為了某個客戶的外觀改一行程式碼。
 */
export interface StorefrontTheme {
  readonly id: string;
  readonly name: string;
  readonly optionsSchema: ZodTypeAny;
  renderHome(ctx: ThemeContext, data: { products: ThemeProductView[] }): string;
  renderProduct(ctx: ThemeContext, data: { product: ThemeProductView }): string;
  renderOrder(ctx: ThemeContext, data: { order: ThemeOrderView }): string;
  renderError(ctx: ThemeContext, data: { status: number; message: string }): string;
  /**
   * 登入與註冊。結帳需要身分之後，商店若沒有這兩頁就等於關門，
   * 因此它是 Theme 契約的一部分而不是選配。
   */
  renderAuth(ctx: ThemeContext, data: ThemeAuthView): string;
}
