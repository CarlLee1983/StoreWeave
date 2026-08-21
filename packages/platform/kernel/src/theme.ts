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

export interface ThemeContext {
  storeName: string;
  storeId: string;
  currency: string;
  locale: string;
  publicUrl: string;
  supportEmail?: string;
  /** 由 commerce.yaml 的 theme.options 提供，已通過 optionsSchema 驗證。 */
  options: Record<string, unknown>;
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
}
