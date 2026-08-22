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

export interface ThemeAccountOrdersView {
  orders: ThemeOrderSummaryView[];
  /** 分頁：目前這一頁的起點與每頁筆數，以及總筆數。 */
  limit: number;
  offset: number;
  total: number;
}

export interface ThemeOrderSummaryView {
  number: string;
  status: string;
  currency: string;
  totalCents: number;
  placedAt: Date;
  lineCount: number;
}

export interface ThemeAccountProfileView {
  displayName: string;
  phone: string | null;
  /** 已設定的生日不能自己改，畫面要說得出為什麼。 */
  birthday: string | null;
  address: {
    recipient: string; phone: string; postcode: string; city: string; line1: string; line2: string | null;
  } | null;
  saved?: boolean;
  error?: string;
}

export interface ThemeAuthView {
  mode: 'login' | 'register' | 'forgot-password' | 'reset-password';
  /** reset-password 用：從信件連結帶進來的 token。 */
  token?: string;
  /** 中性訊息或成功提示。 */
  notice?: string;
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
  /**
   * 一次性提示，例如「登入時有下架商品被移出購物車」。
   * 由 Storefront 讀取後即清除，Theme 只負責顯示。
   */
  notice?: string | null;
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
  /** 會員中心的訂單清單。 */
  renderAccountOrders(ctx: ThemeContext, data: ThemeAccountOrdersView): string;
  /** 會員中心的個人資料與收件地址。 */
  renderAccountProfile(ctx: ThemeContext, data: ThemeAccountProfileView): string;
}
