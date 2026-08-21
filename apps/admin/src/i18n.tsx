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
} as const;

type MessageKey = keyof typeof zhTW;
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
};

const catalog: Record<Locale, Messages> = { 'zh-TW': zhTW, 'en-US': enUS, 'ja-JP': jaJP };
const statusKeys: Record<string, MessageKey> = { draft: 'draft', active: 'active', archived: 'archived', pending: 'pending', payment_processing: 'payment_processing', paid: 'paid', cancelled: 'cancelled', expired: 'expired', sent: 'sent', failed: 'failed' };

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
