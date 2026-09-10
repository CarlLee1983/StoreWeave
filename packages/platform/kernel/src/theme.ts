import type { ZodTypeAny } from 'zod';
import type { PageMap, PageRenderer, ViewOf } from './page';

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


/**
 * 購物車的呈現資料。金額全部是**當下**重算的結果——購物車不凍結價格，
 * Theme 拿到的永遠是現在的數字。
 */





/** Theme 拿到的一個導覽項目。`group` 是頁尾小標，沒有分組時不存在。 */
export interface ThemeNavigationItem {
  readonly label: string;
  readonly href: string;
  readonly group?: string;
}

/**
 * menu slug → 項目。平台不規定一個網站有哪幾組選單，Theme 讀它認得的那幾組
 * （ADR 0046）——`primary` 與 `footer` 是預設 Theme 的用法，不是契約。
 */
export type ThemeNavigation = Readonly<Record<string, readonly ThemeNavigationItem[]>>;

export interface ThemeContext {
  storeName: string;
  storeId: string;
  /**
   * 商店貨幣。base-only 的網站沒有貨幣這個概念，所以它是選填——
   * 需要它的是商務頁的 renderer，不是每一個網站（ADR 0045）。
   */
  currency?: string;
  locale: string;
  /** IANA 時區，來自 `store.timezone`。日期一律以它顯示，不用主機時區。 */
  timeZone: string;
  publicUrl: string;
  supportEmail?: string;
  /**
   * 目前選用 theme 的視覺設定，由設定檔的 `theme.options[<theme id>]` 提供，
   * 已通過 optionsSchema 驗證。依 theme id 分開保存，換回去時原本的配色還在（ADR 0045）。
   */
  options: Record<string, unknown>;
  /**
   * 網站標語。存在資料庫而不是 theme options：換 theme 不該換掉標語（ADR 0046）。
   */
  tagline?: string;
  /** 頁尾附註，與標語同源。 */
  footerNote?: string;
  /**
   * 導覽。內容由資料決定，Theme 只負責排版——硬編碼一份連結清單等於讓資訊架構
   * 跟著外觀走（ADR 0046）。沒有 site 模組的 release 拿到空物件。
   */
  navigation?: ThemeNavigation;
  /** 已登入時的顯示名稱；未登入為 null。 */
  customerName?: string | null;
  /** 登入者的 CSRF token。寫入表單必須把它放進隱藏欄位 `_csrf`。 */
  csrfToken?: string | null;
  /**
   * 哪幾種品牌內容目前有已發布的文章。導覽列靠它決定要不要出現入口——
   * Theme 不該自己猜哪些頁面存在（ADR 0033）。種類由 content 模組定義，
   * 平台不認得它們，所以這裡是字串（ADR 0045）。
   */
  publishedContentKinds?: readonly string[];
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
 * Theme 作者呼叫這個而不是直接寫物件字面量：型別參數 `Pages` 決定 renderers 的鍵
 * 與每個 view 的型別，形狀對不上就是編譯期錯誤。傳型別而不是值，Theme 因此不必
 * 依賴各模組的執行期實例——它要的只是「這些頁面長什麼樣」。
 */
/**
 * 沒有路由的必需頁面各自的 view。SYSTEM_PAGE_IDS 是同一份清單的執行期形式，
 * 兩邊要一起改——啟動檢查看 id，型別看形狀。
 */
export interface SystemPageViews {
  'platform.error': { status: number; message: string };
  'platform.auth': ThemeAuthView;
}

export function defineTheme<Pages extends PageMap>(
  theme: Omit<StorefrontTheme, 'renderers'> & {
    /**
     * 型別管形狀，啟動檢查管完整性：這裡逐一比對每個 renderer 收到的 view，
     * 「少了哪一頁」交給 assertThemeCoversPages——只做寫入與轉址的頁面沒有畫面，
     * 在型別層分不出它們，硬要求就會逼出一堆空 renderer。
     */
    readonly renderers:
      & Partial<{ readonly [K in keyof Pages & string as Pages[K]['id']]: PageRenderer<ViewOf<Pages[K]>> }>
      & { readonly [K in keyof SystemPageViews]: PageRenderer<SystemPageViews[K]> };
  },
): StorefrontTheme {
  return theme as StorefrontTheme;
}
