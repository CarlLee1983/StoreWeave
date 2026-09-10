import type { ZodTypeAny } from 'zod';
import type { PageMap, PageRenderer, ViewOf } from './page';

export interface ThemeProductView {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  available: number | null;
}

/** Public catalog result: filtering and pagination remain server-derived. */
export interface ThemeCatalogView {
  products: ThemeProductView[];
  q: string;
  /** Whole currency units supplied by the public form; null means unbounded. */
  minPrice: number | null;
  maxPrice: number | null;
  page: number;
  pageSize: number;
  total: number;
}

/** 一篇可發布的編輯文字。內容歸 content 模組，Theme 只決定它長什麼樣（ADR 0033）。 */
export interface ThemeArticleView {
  kind: 'story' | 'journal' | 'news' | 'faq';
  slug: string;
  title: string;
  summary: string;
  /** 標題上方的分組字樣：生活誌的欄目、FAQ 的分類。沒有就是空字串。 */
  section: string;
  /** 段落區塊。`heading` 只有品牌故事的章節會用到，其餘一律 null。 */
  body: { heading: string | null; text: string }[];
  /**
   * Theme 自己擁有的照片 key，不含路徑與副檔名（ADR 0034）。
   * key 指向的圖可能已經從 Theme 拿掉，版型必須容得下沒有圖。
   */
  imageKey: string | null;
  publishedAt: Date | null;
}

export interface ThemeArticleListView {
  kind: ThemeArticleView['kind'];
  articles: ThemeArticleView[];
}

/** 首頁同時要商品與品牌內容；沒有發布任何品牌內容的商店拿到 null 與空陣列。 */
export interface ThemeHomeView extends ThemeCatalogView {
  story: ThemeArticleView | null;
  journal: ThemeArticleView[];
  news: ThemeArticleView[];
}

/**
 * 聯絡我們。送出成功後以 `submitted` 呈現結果頁，失敗則帶回填值與錯誤——
 * 這是標準表單 POST，沒有 JavaScript 也要說得清楚發生了什麼。
 */
export interface ThemeContactView {
  submitted: boolean;
  values: { name: string; email: string; subject: string; message: string };
  error?: string;
}

export interface ThemeOrderView {
  number: string;
  status: string;
  currency: string;
  totalCents: number;
  customerEmail: string;
  /** IDs are rendered only as form values for a customer-owned RMA submission. */
  lines: { id: string; sku: string; name: string; quantity: number; lineTotalCents: number }[];
  /** Latest attempt is presented without exposing provider-specific raw callback fields. */
  payment: {
    status: 'created' | 'submitted' | 'awaiting_payment' | 'succeeded' | 'failed' | 'expired';
    method: string;
    action: { type: 'redirect'; url: string } | { type: 'form_post'; url: string; fields: Record<string, string> } | null;
    instructions: { label: string; value: string }[] | null;
    expiresAt: Date | null;
  } | null;
  /** Only pending orders get a new attempt; active deferred attempts are resumed in place. */
  paymentRetry: {
    provider: string;
    methods: { code: string; label: string; timing: 'immediate' | 'deferred' }[];
  } | null;
  /** Customer-safe invoice progress. Carrier values and provider diagnostics stay private. */
  invoice?: { status: 'pending' | 'issued' | 'issue_failed' | 'void_pending' | 'voided' | 'void_failed'; invoiceNumber: string | null } | null;
  /** The command still rechecks ownership, payment state, and the shipment gate. */
  canCancel: boolean;
  /** Immutable delivery snapshot, so an order remains intelligible after merchant policy changes. */
  delivery: {
    shippingMethodName: string;
    destination: {
      kind: 'taiwan_home'; recipient: string; phone: string; postcode: string; city: string; district: string; line1: string; line2: string | null;
    } | {
      kind: 'pickup_store'; recipient: string; phone: string; storeName: string; storeAddress: string;
    };
  } | null;
  /** Safe, normalized shipment projection; raw carrier status and references stay private. */
  shipment: {
    status: 'created' | 'shipped' | 'arrived' | 'completed';
    trackingNumber: string | null;
    trackingUrl: string | null;
  } | null;
  /** Customer-safe refund progress; provider evidence and staff reason stay private. */
  refunds: { amountCents: number; status: 'requested' | 'succeeded' | 'failed'; requestedAt: Date; completedAt: Date | null }[];
  /** The domain command remains the authority for eligibility and remaining quantities. */
  canRequestRma: boolean;
  /** Customer-scoped RMA progress; identities, provider evidence, and inventory disposition stay private. */
  rmas: {
    status: 'requested' | 'needs_information' | 'approved' | 'rejected' | 'received' | 'refund_pending' | 'refund_failed' | 'completed';
    reason: string;
    staffNote: string | null;
    createdAt: Date;
    lines: { name: string; quantity: number }[];
  }[];
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
    countryCode: 'TW'; recipient: string; phone: string; postcode: string; city: string; district: string | null;
    line1: string; line2: string | null;
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
  /** Merchant methods compatible with address or pickup checkout. */
  shippingMethods: {
    id: string;
    name: string;
    /** Omitted by older themes/tests; it retains the historical home-delivery rendering. */
    destinationKind?: 'taiwan_home' | 'pickup_store';
    feeCents: number;
    freeShippingThresholdCents: number | null;
  }[];
  /** The selected merchant method and all-in amount are server-derived for this render. */
  selectedShippingMethodId: string;
  shippingPreview: { shippingCents: number; totalCents: number };
  /** Prefill only: the form still submits a fresh, explicit destination. */
  deliveryAddress: {
    recipient: string;
    phone: string;
    postcode: string;
    city: string;
    district: string | null;
    line1: string;
    line2: string | null;
  } | null;
  pickupSelection?: { token: string; storeName: string; storeAddress: string } | null;
  /** The store selects a provider; the customer must select its configured method before redirection. */
  payment: {
    provider: string;
    methods: { code: string; label: string; timing: 'immediate' | 'deferred' }[];
  };
  /** Present only when the merchant has enabled a B2C invoice provider. */
  invoice?: { enabled: boolean };
}

export interface ThemePickupStorePickerView {
  token: string;
  shippingMethodId: string;
  expiresAt: Date;
  stores: { providerStoreId: string; storeName: string; storeAddress: string }[];
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
  /** IANA 時區，來自 `store.timezone`。日期一律以它顯示，不用主機時區。 */
  timeZone: string;
  publicUrl: string;
  supportEmail?: string;
  /** 由 commerce.yaml 的 theme.options 提供，已通過 optionsSchema 驗證。 */
  options: Record<string, unknown>;
  /** 已登入時的顯示名稱；未登入為 null。 */
  customerName?: string | null;
  /** 登入者的 CSRF token。寫入表單必須把它放進隱藏欄位 `_csrf`。 */
  csrfToken?: string | null;
  /**
   * 哪幾種品牌內容目前有已發布的文章。導覽列靠它決定要不要出現入口——
   * Theme 不該自己猜哪些頁面存在（ADR 0033）。
   */
  publishedContentKinds?: readonly ThemeArticleView['kind'][];
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
  /**
   * 這個 Theme 可以配給文章的照片 key（ADR 0034）。後台從這份清單挑，
   * 永遠不是自己填一個路徑。沒有宣告就是這個 Theme 的文章不配圖。
   */
  readonly editorialImageKeys?: readonly string[];
  /**
   * page id → renderer。Theme 服務哪些頁面由它實作了哪些 id 決定，缺哪些必需頁
   * 在 release 組裝時比對出來並拒絕啟動（ADR 0045）——不是在這裡宣告一份方法清單，
   * 那會讓平台層的契約重新編碼商務領域。
   */
  readonly renderers: Readonly<Record<string, PageRenderer<any>>>;
}

/**
 * Theme 作者呼叫這個而不是直接寫物件字面量：`pages` 決定 renderers 的鍵與每個
 * view 的型別，少寫一頁或簽名對不上都是編譯期錯誤，不必等到啟動時的缺頁檢查。
 */
export function defineTheme<Pages extends PageMap>(
  pages: Pages,
  theme: Omit<StorefrontTheme, 'renderers'> & {
    readonly renderers: { readonly [K in keyof Pages & string as Pages[K]['id']]: PageRenderer<ViewOf<Pages[K]>> };
  },
): StorefrontTheme {
  void pages;
  return theme;
}
