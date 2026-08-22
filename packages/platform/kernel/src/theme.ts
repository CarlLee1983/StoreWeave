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

interface ThemeAuthBase {
  /** 完成後要回到哪裡。只接受站內路徑。 */
  next: string;
  error?: string;
}

/**
 * discriminated union 而不是「全部 optional」：`token` 只對重設密碼有意義，
 * `notice` 只對忘記密碼有意義。攤平成選填欄位會讓 Theme 得自己記住哪個模式該讀哪個。
 */
export type ThemeAuthView =
  | (ThemeAuthBase & { mode: 'login' | 'register' })
  | (ThemeAuthBase & { mode: 'forgot-password'; notice?: string })
  | (ThemeAuthBase & { mode: 'reset-password'; token: string });

export interface ThemeCartLineView {
  productId: string;
  sku: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
  /** 攤到這一行的折扣與折後金額。 */
  discountCents: number;
  netCents: number;
  /** 目前可售量，null 代表沒有庫存紀錄。購物車不預留，這只是顯示用。 */
  available: number | null;
}

/**
 * 購物車的呈現資料。金額全部是**當下**重算的結果——購物車不凍結價格，
 * Theme 拿到的永遠是現在的數字。
 */
export interface ThemeCartView {
  /** 結帳表單要把它帶回來：它是那次結帳的冪等鍵。 */
  cartId: string;
  currency: string;
  lines: ThemeCartLineView[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  adjustments: { name: string; amountCents: number }[];
  /** 已經買不到而被拿掉的商品。顧客要在結帳之前就知道。 */
  removedNames: string[];
  /** 差一點就達成的門檻活動；沒有就是 null。 */
  nextThreshold: { name: string; remainingCents: number } | null;
  /** 本次套用的券。券不生效時 `discountCents` 是 0。 */
  coupon: { code: string; discountCents: number } | null;
  /** 券失效或輸入錯誤的原因。留著訊息而不是靜靜拿掉，顧客才知道發生了什麼。 */
  couponError: string | null;
  /**
   * 購物金折抵。未登入時為 null——訪客沒有帳本。
   * `requestedCents` 與 `appliedCents` 不同時，畫面要說得出為什麼。
   */
  reward: {
    requestedCents: number;
    appliedCents: number;
    availableCents: number;
    maxCents: number;
  } | null;
  error?: string;
}

export interface ThemeAccountCouponsView {
  coupons: {
    code: string;
    promotionName: string;
    /** 這張券折什麼，已經是可以直接顯示的句子。 */
    description: string;
    status: 'issued' | 'used' | 'void';
    endsAt: Date | null;
    expiringSoon: boolean;
    usable: boolean;
    /** 不能用的原因；可以用時為 null。 */
    unusableReason: 'used' | 'void' | 'not_started' | 'expired' | 'promotion_ended' | null;
  }[];
}

export interface ThemeCheckoutView extends ThemeCartView {
  /** 訂單會寄到哪裡。結帳必須是會員，因此它一定有值。 */
  customerEmail: string;
}

export interface ThemeAccountRewardsView {
  currency: string;
  balance: {
    availableCents: number;
    /** 已入帳但還沒生效。顧客看得到它才不會以為系統壞了。 */
    pendingCents: number;
    expiredCents: number;
    nextExpiry: { amountCents: number; expiresAt: Date } | null;
  };
  entries: {
    amountCents: number;
    /** 已經翻成人看得懂的來源說法。 */
    description: string;
    effectiveAt: Date;
    expiresAt: Date | null;
    createdAt: Date;
  }[];
  tier: {
    name: string;
    points: number;
    next: { name: string; remainingPoints: number } | null;
    /** 滾動期間的起點與長度。降級時要解釋得了為什麼。 */
    windowStartsAt: Date;
    windowMonths: number;
  };
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
  /**
   * 購物車與結帳。任何購物型 Theme 都必須實作它們，不是選配——
   * 沒有這兩頁的商店等於關著門。
   */
  renderCart(ctx: ThemeContext, data: ThemeCartView): string;
  renderCheckout(ctx: ThemeContext, data: ThemeCheckoutView): string;
  /** 會員中心的購物金與會員等級。 */
  renderAccountRewards(ctx: ThemeContext, data: ThemeAccountRewardsView): string;
  /** 會員中心的我的券。 */
  renderAccountCoupons(ctx: ThemeContext, data: ThemeAccountCouponsView): string;
  /** 會員中心的訂單清單。 */
  renderAccountOrders(ctx: ThemeContext, data: ThemeAccountOrdersView): string;
  /** 會員中心的個人資料與收件地址。 */
  renderAccountProfile(ctx: ThemeContext, data: ThemeAccountProfileView): string;
}
