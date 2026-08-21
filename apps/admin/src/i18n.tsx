import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setDisplayLocale } from './api';

export const LOCALES = ['zh-TW', 'en-US', 'ja-JP'] as const;
export type Locale = (typeof LOCALES)[number];
const STORAGE_KEY = 'storeweave.admin.locale';

const zhTW = {
  navigation: '主要導覽', commerce: 'Commerce', integrations: 'Integrations', orders: '訂單', products: '商品', erpQueue: 'ERP 佇列', systemHealth: '系統健康度', dlq: '死信佇列', online: 'Online',
  searchActions: '搜尋頁面或操作', openCommand: '開啟命令選單', language: '語言', toggleTheme: '切換明暗主題', apiTokenSettings: 'API Token 設定', tokenStored: '憑證只儲存在此瀏覽器。', enterToken: '輸入 API token', clear: '清除', save: '儲存',
  ordersTitle: '訂單管理', ordersSubtitle: '即時交易流與 ERP 投遞管線', productsTitle: '商品管理', productsSubtitle: '管理商品目錄、售價與可用庫存', createProduct: '建立商品', erpTitle: 'ERP 投遞', erpSubtitle: '追蹤訂單事件、重試與 Dead Letter Queue', systemTitle: '系統狀態', systemSubtitle: '服務相依性、擴充套件與銷售匯總', dlqTitle: '死信佇列', dlqSubtitle: '檢視失敗超過重試上限的背景工作並手動重送',
  commandMenu: '命令選單', searchPages: '搜尋頁面…', goTo: '前往', navigateHint: '使用 ↑ ↓ 瀏覽', close: '關閉',
  loading: '載入中…', dismissError: '關閉錯誤訊息', unknownError: '發生未知錯誤', clientError: '用戶端錯誤', invalidCancelReason: '請輸入取消原因', invalidInventory: '請輸入非零整數的調整量與原因', invalidProduct: '請填寫 SKU、名稱，以及非負整數的價格（cents）',
  allStatuses: '全部狀態', draft: '草稿', active: '上架中', archived: '已下架', pending: '待付款', payment_processing: '付款處理中', paid: '已付款', cancelled: '已取消', expired: '付款逾時', sent: '已送達', failed: '失敗',
  erpPipeline: 'ERP 處理管線', transactionTotal: '交易總額', pendingOrders: '待處理訂單', completedOrders: '已完成訂單', currentlyShown: '目前顯示', orderNumber: '訂單編號', customer: '客戶', status: '狀態', total: '總金額', orderedAt: '下單時間', collapse: '收合', view: '檢視', sku: 'SKU', name: '名稱', unitPrice: '單價', quantity: '數量', subtotal: '小計', requestPayment: '要求付款', cancellationReason: '取消原因', cancelOrder: '取消訂單',
  searchProducts: '搜尋商品名稱或 SKU', price: '價格', inventory: '庫存（可用 / 保留 / 現有）', adjustInventory: '調整庫存', adjustment: '調整量', reason: '原因', adjust: '調整', priceCents: '價格（cents）', currency: '幣別', create: '建立',
  reference: '參考碼', attempts: '嘗試次數', manualResends: '手動重送次數', lastError: '最後錯誤', remoteId: '遠端 ID', payload: 'Payload', resend: '重送', payloadDialog: 'ERP payload', closePayload: '關閉 Payload', payloadNotice: '此預覽由目前 ERP 設定產生，下一次重送會使用相同 HTTP JSON body；不包含 API key。', copied: '已複製', copyJson: '複製 JSON', resending: '重送中…', resendToErp: '重送至 ERP',
  dependencyHealth: '依賴健康檢查', detail: '詳情', installedExtensions: '已安裝擴充套件', platform: '平台', permissions: '權限', subscribedEvents: '訂閱事件', commands: '指令', queries: '查詢', providers: 'Providers', mcpTools: 'MCP 工具', none: '無', salesSummary: '銷售摘要', from: '從', to: '到', paidOrders: '已付款訂單', cancelledOrders: '已取消訂單', grossRevenue: '總營收', averageOrderValue: '平均客單價', productName: '商品名稱', salesQuantity: '銷售數量', revenue: '營收',
  jobType: '工作類型', maxAttempts: '重試上限', failedAt: '失敗時間', noDeadJobs: '目前沒有死信工作。',
  discount: '折扣', netAmount: '實收', appliedPromotions: '套用的活動',
  promotions: '促銷活動', promotionsTitle: '促銷活動', promotionsSubtitle: '建立滿額折與整單折扣，設定期間、優先序與疊加規則', createPromotion: '建立活動', promotionName: '活動名稱', ruleType: '規則型別', threshold_fixed_amount: '滿額折固定金額', threshold_percentage: '滿額折百分比', order_percentage: '整單百分比', thresholdCents: '門檻（cents）', discountCents: '折抵金額（cents）', percentOff: '折扣百分比', maxDiscountCents: '折扣上限（cents，留空為不限）', priority: '優先序', stackable: '可與其他活動疊加', period: '活動期間', startsAt: '開始時間', endsAt: '結束時間', disable: '停用', enable: '啟用', disabled: '已停用', noPromotions: '目前沒有促銷活動。', invalidPromotion: '請填寫活動名稱，門檻與折抵金額需為非負整數，折抵金額須大於零', invalidPercent: '折扣百分比需介於 0 與 100 之間且大於零',
  loginTitle: '登入 StoreWeave', loginSubtitle: '請使用你的帳號密碼登入後台', email: '電子郵件', password: '密碼', login: '登入', loggingIn: '登入中…', logout: '登出',
} as const;

export type MessageKey = keyof typeof zhTW;
type Messages = Record<MessageKey, string>;

const enUS: Messages = {
  navigation: 'Main navigation', commerce: 'Commerce', integrations: 'Integrations', orders: 'Orders', products: 'Products', erpQueue: 'ERP queue', systemHealth: 'System health', dlq: 'Dead letter queue', online: 'Online',
  searchActions: 'Search pages or actions', openCommand: 'Open command menu', language: 'Language', toggleTheme: 'Toggle color theme', apiTokenSettings: 'API token settings', tokenStored: 'Credentials are stored only in this browser.', enterToken: 'Enter API token', clear: 'Clear', save: 'Save',
  ordersTitle: 'Order management', ordersSubtitle: 'Live transaction flow and ERP delivery pipeline', productsTitle: 'Product management', productsSubtitle: 'Manage product catalog, prices, and available stock', createProduct: 'Create product', erpTitle: 'ERP delivery', erpSubtitle: 'Track order events, retries, and the dead-letter queue', systemTitle: 'System status', systemSubtitle: 'Service dependencies, extensions, and sales summary', dlqTitle: 'Dead letter queue', dlqSubtitle: 'Review background jobs that exhausted their retries and resend them manually',
  commandMenu: 'Command menu', searchPages: 'Search pages…', goTo: 'Go to', navigateHint: 'Use ↑ ↓ to navigate', close: 'Close', loading: 'Loading…', dismissError: 'Dismiss error message', unknownError: 'An unknown error occurred', clientError: 'Client error', invalidCancelReason: 'Enter a cancellation reason', invalidInventory: 'Enter a non-zero integer adjustment and reason', invalidProduct: 'Enter SKU, name, and a non-negative integer price in cents',
  allStatuses: 'All statuses', draft: 'Draft', active: 'Active', archived: 'Archived', pending: 'Pending payment', payment_processing: 'Processing payment', paid: 'Paid', cancelled: 'Cancelled', expired: 'Payment expired', sent: 'Delivered', failed: 'Failed',
  erpPipeline: 'ERP processing pipeline', transactionTotal: 'Transaction total', pendingOrders: 'Pending orders', completedOrders: 'Completed orders', currentlyShown: 'Currently shown', orderNumber: 'Order number', customer: 'Customer', status: 'Status', total: 'Total', orderedAt: 'Ordered at', collapse: 'Collapse', view: 'View', sku: 'SKU', name: 'Name', unitPrice: 'Unit price', quantity: 'Quantity', subtotal: 'Subtotal', requestPayment: 'Request payment', cancellationReason: 'Cancellation reason', cancelOrder: 'Cancel order',
  searchProducts: 'Search product name or SKU', price: 'Price', inventory: 'Stock (available / reserved / on hand)', adjustInventory: 'Adjust stock', adjustment: 'Adjustment', reason: 'Reason', adjust: 'Adjust', priceCents: 'Price (cents)', currency: 'Currency', create: 'Create',
  reference: 'Reference', attempts: 'Attempts', manualResends: 'Manual resends', lastError: 'Last error', remoteId: 'Remote ID', payload: 'Payload', resend: 'Resend', payloadDialog: 'ERP payload', closePayload: 'Close payload', payloadNotice: 'This preview uses the current ERP settings. The next resend uses the same HTTP JSON body; API keys are excluded.', copied: 'Copied', copyJson: 'Copy JSON', resending: 'Resending…', resendToErp: 'Resend to ERP',
  dependencyHealth: 'Dependency health checks', detail: 'Detail', installedExtensions: 'Installed extensions', platform: 'Platform', permissions: 'Permissions', subscribedEvents: 'Subscribed events', commands: 'Commands', queries: 'Queries', providers: 'Providers', mcpTools: 'MCP tools', none: 'None', salesSummary: 'Sales summary', from: 'From', to: 'To', paidOrders: 'Paid orders', cancelledOrders: 'Cancelled orders', grossRevenue: 'Gross revenue', averageOrderValue: 'Average order value', productName: 'Product name', salesQuantity: 'Quantity sold', revenue: 'Revenue',
  jobType: 'Job type', maxAttempts: 'Max attempts', failedAt: 'Failed at', noDeadJobs: 'No dead jobs right now.',
  discount: 'Discount', netAmount: 'Net', appliedPromotions: 'Applied promotions',
  promotions: 'Promotions', promotionsTitle: 'Promotions', promotionsSubtitle: 'Create threshold and order-wide discounts with periods, priority, and stacking rules', createPromotion: 'Create promotion', promotionName: 'Promotion name', ruleType: 'Rule type', threshold_fixed_amount: 'Fixed amount off above threshold', threshold_percentage: 'Percentage off above threshold', order_percentage: 'Percentage off the order', thresholdCents: 'Threshold (cents)', discountCents: 'Discount amount (cents)', percentOff: 'Percent off', maxDiscountCents: 'Max discount (cents, blank for none)', priority: 'Priority', stackable: 'Stacks with other promotions', period: 'Period', startsAt: 'Starts at', endsAt: 'Ends at', disable: 'Disable', enable: 'Enable', disabled: 'Disabled', noPromotions: 'No promotions yet.', invalidPromotion: 'Enter a name; threshold and discount must be non-negative integers and the discount must be greater than zero', invalidPercent: 'Percent off must be greater than 0 and at most 100',
  loginTitle: 'Sign in to StoreWeave', loginSubtitle: 'Sign in with your account to access the admin console', email: 'Email', password: 'Password', login: 'Sign in', loggingIn: 'Signing in…', logout: 'Sign out',
};

const jaJP: Messages = {
  navigation: 'メインナビゲーション', commerce: 'Commerce', integrations: 'Integrations', orders: '注文', products: '商品', erpQueue: 'ERP キュー', systemHealth: 'システムヘルス', dlq: 'デッドレターキュー', online: 'オンライン',
  searchActions: 'ページまたは操作を検索', openCommand: 'コマンドメニューを開く', language: '言語', toggleTheme: 'カラーテーマを切り替え', apiTokenSettings: 'API トークン設定', tokenStored: '認証情報はこのブラウザだけに保存されます。', enterToken: 'API トークンを入力', clear: 'クリア', save: '保存',
  ordersTitle: '注文管理', ordersSubtitle: 'リアルタイムの取引フローと ERP 配信パイプライン', productsTitle: '商品管理', productsSubtitle: '商品カタログ、価格、利用可能在庫を管理', createProduct: '商品を作成', erpTitle: 'ERP 配信', erpSubtitle: '注文イベント、再試行、デッドレターキューを追跡', systemTitle: 'システム状態', systemSubtitle: 'サービス依存関係、拡張機能、売上集計', dlqTitle: 'デッドレターキュー', dlqSubtitle: '再試行の上限に達したバックグラウンドジョブを確認し、手動で再送します',
  commandMenu: 'コマンドメニュー', searchPages: 'ページを検索…', goTo: '移動', navigateHint: '↑ ↓ で移動', close: '閉じる', loading: '読み込み中…', dismissError: 'エラーメッセージを閉じる', unknownError: '不明なエラーが発生しました', clientError: 'クライアントエラー', invalidCancelReason: 'キャンセル理由を入力してください', invalidInventory: 'ゼロ以外の整数の調整量と理由を入力してください', invalidProduct: 'SKU、名前、0 以上の整数価格（セント）を入力してください',
  allStatuses: 'すべての状態', draft: '下書き', active: '公開中', archived: 'アーカイブ済み', pending: '支払い待ち', payment_processing: '支払い処理中', paid: '支払い済み', cancelled: 'キャンセル済み', expired: '支払い期限切れ', sent: '配信済み', failed: '失敗',
  erpPipeline: 'ERP 処理パイプライン', transactionTotal: '取引合計', pendingOrders: '保留中の注文', completedOrders: '完了した注文', currentlyShown: '表示中', orderNumber: '注文番号', customer: '顧客', status: '状態', total: '合計', orderedAt: '注文日時', collapse: '折りたたむ', view: '表示', sku: 'SKU', name: '名前', unitPrice: '単価', quantity: '数量', subtotal: '小計', requestPayment: '支払いを依頼', cancellationReason: 'キャンセル理由', cancelOrder: '注文をキャンセル',
  searchProducts: '商品名または SKU を検索', price: '価格', inventory: '在庫（利用可能 / 引当 / 手持ち）', adjustInventory: '在庫を調整', adjustment: '調整量', reason: '理由', adjust: '調整', priceCents: '価格（セント）', currency: '通貨', create: '作成',
  reference: '参照コード', attempts: '試行回数', manualResends: '手動再送回数', lastError: '最終エラー', remoteId: 'リモート ID', payload: 'ペイロード', resend: '再送', payloadDialog: 'ERP ペイロード', closePayload: 'ペイロードを閉じる', payloadNotice: 'このプレビューは現在の ERP 設定から生成されます。次回の再送では同じ HTTP JSON 本文を使用し、API キーは含まれません。', copied: 'コピーしました', copyJson: 'JSON をコピー', resending: '再送中…', resendToErp: 'ERP に再送',
  dependencyHealth: '依存関係のヘルスチェック', detail: '詳細', installedExtensions: 'インストール済み拡張機能', platform: 'プラットフォーム', permissions: '権限', subscribedEvents: '購読イベント', commands: 'コマンド', queries: 'クエリ', providers: 'プロバイダー', mcpTools: 'MCP ツール', none: 'なし', salesSummary: '売上概要', from: '開始', to: '終了', paidOrders: '支払い済み注文', cancelledOrders: 'キャンセル済み注文', grossRevenue: '総売上', averageOrderValue: '平均注文額', productName: '商品名', salesQuantity: '販売数量', revenue: '売上',
  jobType: 'ジョブ種別', maxAttempts: '再試行上限', failedAt: '失敗日時', noDeadJobs: '現在デッドレターキューにジョブはありません。',
  discount: '割引', netAmount: '実収', appliedPromotions: '適用プロモーション',
  promotions: 'プロモーション', promotionsTitle: 'プロモーション', promotionsSubtitle: '期間・優先度・併用ルールを設定して割引を作成します', createPromotion: 'プロモーションを作成', promotionName: 'プロモーション名', ruleType: 'ルール種別', threshold_fixed_amount: '一定額以上で定額割引', threshold_percentage: '一定額以上で定率割引', order_percentage: '注文全体の定率割引', thresholdCents: 'しきい値（セント）', discountCents: '割引額（セント）', percentOff: '割引率', maxDiscountCents: '割引上限（セント、空欄で無制限）', priority: '優先度', stackable: '他のプロモーションと併用可', period: '期間', startsAt: '開始日時', endsAt: '終了日時', disable: '無効化', enable: '有効化', disabled: '無効', noPromotions: 'プロモーションはまだありません。', invalidPromotion: '名前を入力し、しきい値と割引額は 0 以上の整数、割引額は 0 より大きい値にしてください', invalidPercent: '割引率は 0 より大きく 100 以下にしてください',
  loginTitle: 'StoreWeave にサインイン', loginSubtitle: 'アカウントでサインインして管理画面にアクセスします', email: 'メールアドレス', password: 'パスワード', login: 'サインイン', loggingIn: 'サインイン中…', logout: 'サインアウト',
};

const catalog: Record<Locale, Messages> = { 'zh-TW': zhTW, 'en-US': enUS, 'ja-JP': jaJP };
const statusKeys: Record<string, MessageKey> = { draft: 'draft', active: 'active', archived: 'archived', disabled: 'disabled', pending: 'pending', payment_processing: 'payment_processing', paid: 'paid', cancelled: 'cancelled', expired: 'expired', sent: 'sent', failed: 'failed' };

type I18n = { locale: Locale; setLocale: (locale: Locale) => void; t: (key: MessageKey) => string; formatMoney: (cents: number, currency: string) => string; formatDateTime: (value: string | Date) => string; statusLabel: (value: string) => string };
const I18nContext = createContext<I18n | null>(null);

function initialLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY);
  return LOCALES.includes(stored as Locale) ? stored as Locale : 'zh-TW';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  useEffect(() => { document.documentElement.lang = locale; localStorage.setItem(STORAGE_KEY, locale); setDisplayLocale(locale); }, [locale]);
  const value = useMemo<I18n>(() => ({
    locale, setLocale, t: (key) => catalog[locale][key],
    formatMoney: (cents, currency) => new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100),
    formatDateTime: (date) => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(date)),
    statusLabel: (status) => { const key = statusKeys[status.toLowerCase()]; return key ? catalog[locale][key] : status; },
  }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used within I18nProvider');
  return value;
}
