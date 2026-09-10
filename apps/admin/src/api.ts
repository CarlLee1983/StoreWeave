// API 型別與 fetch wrapper。所有請求集中在這裡，畫面元件不直接呼叫 fetch。
import type { AdminOrder, AdminOrderAdjustment, AdminOrderLine } from '@storeweave/order/http';

export type Coupon = {
  id: string;
  code: string;
  promotionId: string;
  status: 'issued' | 'used' | 'void';
  /** null 代表共用碼：誰都能用。 */
  customerId: string | null;
  partnerCode: string | null;
  maxRedemptions: number | null;
  redeemedCount: number;
  perCustomerLimit: number | null;
  source: string;
  batchId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type IssueResult = {
  batchId: string;
  issued: number;
  skipped: number;
};

export type Product = {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  status: 'draft' | 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
};

export type Stock = {
  productId: string;
  onHand: number;
  reserved: number;
  available: number;
  updatedAt: string;
};

export type OrderLine = AdminOrderLine;
export type OrderAdjustment = AdminOrderAdjustment;
export type Order = AdminOrder;

export type ShippingMethod = {
  id: string;
  code: string;
  name: string;
  provider: string;
  type: string;
  destinationKind: 'taiwan_home' | 'pickup_store';
  feeCents: number;
  freeShippingThresholdCents: number | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Shipment = {
  id: string;
  orderId: string;
  shippingMethodId: string;
  provider: string;
  type: string;
  providerRef: string | null;
  trackingNumber: string | null;
  status: 'created' | 'shipped' | 'arrived' | 'completed';
  createdAt: string;
  shippedAt: string | null;
  arrivedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

/** Safe operational projection from the ECPay Logistics extension. */
export type EcpayLogisticsShipmentOperation = {
  shipmentId: string;
  orderId: string;
  status: 'pending' | 'created' | 'failed';
  attempts: number;
  manualRetries: number;
  lastError: string | null;
  providerRef: string | null;
  trackingNumber: string | null;
  labelAvailable: boolean;
  lastKnownStage: Shipment['status'];
  lastStatusQueriedAt: string | null;
  lastStatusQueryError: string | null;
  jobId: string | null;
  firstSeenAt: string;
  updatedAt: string;
};

/** Private, opaque carrier label handle. Never interpret it as a URL. */
export type ShipmentLabelInfo = { shipmentId: string; provider: string; providerRef: string; labelReference: string };

export type Refund = {
  id: string;
  orderId: string;
  amountCents: number;
  currency: string;
  status: 'requested' | 'succeeded' | 'failed';
  reason: string;
  failureMessage: string | null;
  requestedAt: string;
  completedAt: string | null;
};

export type RmaLine = {
  id: string;
  orderLineId: string;
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  discountCents: number;
  disposition: 'restock' | 'discard' | null;
  discardReason: string | null;
};

export type Rma = {
  id: string;
  orderId: string;
  customerId: string;
  status: 'requested' | 'needs_information' | 'approved' | 'rejected' | 'received' | 'refund_pending' | 'refund_failed' | 'completed';
  resolution: 'refund_and_reorder';
  reason: string;
  staffNote: string | null;
  refundId: string | null;
  receivedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: RmaLine[];
};

export type InvoiceCarrier =
  | { kind: 'ecpay' }
  | { kind: 'mobile'; number: string }
  | { kind: 'natural_person'; number: string }
  | { kind: 'donation'; loveCode: string };

export type Invoice = {
  id: string;
  orderId: string;
  orderNumber: string;
  provider: string;
  reference: string;
  currency: string;
  amountCents: number;
  taxCents: number;
  carrier: InvoiceCarrier;
  status: 'pending' | 'issued' | 'issue_failed' | 'void_pending' | 'voided' | 'void_failed';
  providerRef: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  issueAttempts: number;
  voidAttempts: number;
  lastError: string | null;
  issuedAt: string | null;
  voidedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LifecycleDelivery = {
  id: string;
  eventId: string;
  orderId: string;
  template: 'customer.order-placed' | 'customer.order-paid' | 'customer.shipment-shipped' | 'customer.shipment-arrived';
  reference: string;
  /** 伺服器只給遮蔽值；完整地址不離開通知模組。 */
  recipientMasked: string;
  status: 'pending' | 'sent' | 'failed';
  providerRef: string | null;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RewardSettings = {
  /** 基點。100 = 1%。UI 一律換算成百分比。 */
  accrualBasisPoints: number;
  effectiveAfterDays: number;
  expiresAfterDays: number | null;
  expiryNoticeDays: number;
  updatedAt: string;
};

export type Tier = {
  name: string;
  thresholdPoints: number;
  /** 基點。10000 = 1 倍。UI 一律換算成倍數。 */
  multiplierBasisPoints: number;
};

export type PromotionRule =
  | { type: 'threshold_fixed_amount'; thresholdCents: number; discountCents: number }
  | { type: 'threshold_percentage'; thresholdCents: number; percentOffBasisPoints: number; maxDiscountCents?: number | null }
  | { type: 'order_percentage'; percentOffBasisPoints: number; maxDiscountCents?: number | null };

export type Promotion = {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  rule: PromotionRule;
  priority: number;
  stackable: boolean;
  /** 需要券才套用；這種活動不會人人適用。 */
  requiresCoupon: boolean;
  autoIssue: 'signup' | 'birthday' | null;
  autoIssueValidDays: number | null;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminCustomer = {
  id: string;
  accountId: string;
  email: string;
  displayName: string;
  birthday: string | null;
  phone: string | null;
  address: {
    countryCode: 'TW'; recipient: string; phone: string; postcode: string; city: string; district: string | null;
    line1: string; line2: string | null;
  } | null;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
};

export type AdminCustomerDetail = AdminCustomer & {
  orders: { id: string; number: string; status: string; currency: string; totalCents: number; placedAt: string }[];
};

export type CustomerLoyalty = {
  currency: string;
  balance: {
    availableCents: number;
    pendingCents: number;
    expiredCents: number;
    nextExpiry: { amountCents: number; expiresAt: string } | null;
  };
  tierName: string;
  tierPoints: number;
  entries: {
    id: string;
    amountCents: number;
    source: string;
    reference: string | null;
    effectiveAt: string;
    expiresAt: string | null;
    reason: string | null;
    createdAt: string;
  }[];
};

export type PromotionPerformance = {
  promotionId: string;
  name: string;
  redemptionCount: number;
  orderCount: number;
  discountCents: number;
  revenueCents: number;
};

export type AttributionSummary = {
  partnerCode: string;
  orderCount: number;
  revenueCents: number;
  discountCents: number;
};

export type OutstandingRewards = {
  currency: string;
  availableCents: number;
  pendingCents: number;
  customerCount: number;
};

export type SalesSummary = {
  currency: string;
  paidOrderCount: number;
  pendingOrderCount: number;
  cancelledOrderCount: number;
  grossRevenueCents: number;
  averageOrderValueCents: number;
  topProducts: {
    productId: string;
    sku: string;
    name: string;
    quantity: number;
    revenueCents: number;
  }[];
};

export type ExtensionInfo = {
  id: string;
  name: string;
  version: string;
  platformVersion: string;
  permissions: string[];
  subscribedEvents: string[];
  commands: string[];
  queries: string[];
  providers: string[];
  mcpTools: string[];
};

export type Delivery = {
  orderId: string;
  orderNumber: string;
  reference: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  manualResends: number;
  lastError: string | null;
  remoteId: string | null;
  jobId: string | null;
  firstSeenAt: string;
  updatedAt: string;
};

/** 依目前 ERP 設定產生、下一次重送會使用的 JSON body（不含 HTTP headers 或 API key）。 */
export type DeliveryPayload = { orderId: string; payload: Record<string, unknown> };

export type DeadJob = {
  id: string;
  type: string;
  attempts: number;
  maxAttempts: number;
  dedupeKey: string | null;
  lastError: string | null;
  failedAt: string;
};

export type HealthCheck = { name: string; status: string; detail?: string };
export type HealthReport = { status: string; checks: HealthCheck[] };

/** 一個內文區塊；`heading` 只有品牌故事的章節會用到，其餘 kind 一律是 null。 */
export type ArticleBlock = { heading: string | null; text: string };

export type Article = {
  id: string;
  kind: 'story' | 'journal' | 'news' | 'faq';
  slug: string;
  title: string;
  summary: string;
  section: string;
  body: ArticleBlock[];
  /** 封閉清單的 key；不存在的圖由前台自己降級呈現，這裡只負責存字串。 */
  imageKey: string | null;
  position: number;
  status: 'draft' | 'published';
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ContactMessage = {
  id: string;
  customerId: string | null;
  name: string;
  email: string;
  subject: string;
  message: string;
  status: 'new' | 'handled';
  handledByActorId: string | null;
  handledAt: string | null;
  createdAt: string;
};

export type CurrentUser = {
  id: string; email: string; displayName: string; role: string;
  /** 這個角色的權限鍵；admin 是 `['*']`。側欄用它決定列出哪幾頁（B13 片3）。 */
  permissions: readonly string[];
  /** 這個 release 實際載入了哪些模組。沒有 rma 模組就不該有退貨頁。 */
  modules: readonly string[];
};

export type Paged<T> = { items: T[]; total: number };

/** 後台操作者帳號（B13 片4）。 */
export type Operator = {
  id: string; email: string; displayName: string; role: string;
  status: 'active' | 'disabled'; createdAt: string; lastLoginAt: string | null;
};

/** API token 的摘要；秘密只在簽發那一次出現（ADR 0043）。 */
export type ApiToken = {
  id: string; name: string; role: string;
  createdAt: string; expiresAt: string; lastUsedAt: string | null; revokedAt: string | null;
};

export type IssuedApiToken = ApiToken & { secret: string };

/** 站內通知（B07、B13 片5）。 */
export type InboxNotification = {
  id: string; notificationId: string; reference: string; templateId: string;
  title: string; body: string; createdAt: string; readAt: string | null;
};

export type MfaStatus = { enrolled: boolean; confirmed: boolean; recoveryCodesRemaining: number };

/**
 * 登入的回應。它沒有權限與模組清單——那兩份由 `me()` 提供，因為它們是「這個人現在
 * 看得到什麼」而不是登入這件事的結果。`mfaEnrolmentRequired` 只在角色要求第二因素
 * 而帳號還沒註冊時出現（ADR 0044）。
 */
export type LoginResult = {
  id: string; email: string; displayName: string; role: string;
  cartNotice: string | null;
  mfaEnrolmentRequired?: true;
};

/** localStorage 儲存 token 的 key */
export const TOKEN_STORAGE_KEY = 'commerce.admin.token';
let displayLocale = 'zh-TW';

export function setDisplayLocale(locale: string): void {
  displayLocale = locale;
}

export function getDisplayLocale(): string {
  return displayLocale;
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
}

export function setToken(token: string): void {
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

/** API 回傳的錯誤資訊 */
/**
 * 登入缺第二因素時後端回的訊息（`MFA_REQUIRED`，見 `packages/platform/identity/src/auth-service.ts`）。
 * 錯誤碼與「密碼錯了」同樣是 UNAUTHENTICATED，所以只能靠訊息分辨——
 * 它是伺服器常數，不隨語系變動，`tests/integration/account-security.test.ts` 釘住它。
 */
export const MFA_REQUIRED_MESSAGE = 'A multi-factor code is required';

export class ApiError extends Error {
  code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

type Envelope<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string } };

function isEnvelope(value: unknown): value is Envelope<unknown> {
  return typeof value === 'object' && value !== null && 'success' in value;
}

/**
 * 從 document.cookie 讀 CSRF token；帳號登入路徑靠 cookie 驗證的非 GET 請求需要這個 header。
 *
 * 名字在 https 部署上會多一個 `__Host-` 前綴（後端的 `cookieName()`），本機 http 開發沒有，
 * 而這支前端建置時不知道自己會跑在哪一種。兩個都認得——伺服器比對的是由 session token
 * 推導出來的值，不是這張 cookie，因此讀錯一張只會讓請求被拒，不會放行任何東西。
 */
function getCsrfToken(): string {
  // 兩張都在時以有前綴的為準：它是子網域蓋不掉的那一張。
  for (const name of ['__Host-commerce_csrf', 'commerce_csrf']) {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return '';
}

async function request<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    idempotent?: boolean;
    /**
     * 這次操作的冪等鍵。省略時每次現產一把——對「重送就重算」的操作是對的，
     * 但對會生出錢的操作等於沒有保護：連點兩下就是兩筆補償。
     * 那些呼叫端要自己給一把在畫面上固定住的鍵。
     */
    idempotencyKey?: string;
    withAuth?: boolean;
    raw?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const { method = 'GET', body, idempotent = false, idempotencyKey, withAuth = true, raw = false, signal } = options;
  const headers: Record<string, string> = {};

  if (withAuth) {
    const token = getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (method !== 'GET') {
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      headers['x-csrf-token'] = csrfToken;
    }
  }
  if (idempotent) {
    headers['Idempotency-Key'] = idempotencyKey ?? crypto.randomUUID();
  }

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  const json: unknown = await res.json().catch(() => null);

  // 健康端點回的是原始物件而不是 API 信封，但失敗時仍會回信封（例如 session 過期的 401），
  // 所以這裡必須看狀態碼——否則錯誤信封會被當成健康報告傳下去，畫面在 render 時才炸。
  if (raw) {
    if (!res.ok) {
      const error = isEnvelope(json) && !json.success ? json.error : null;
      throw new ApiError(error?.code ?? 'UNKNOWN_ERROR', error?.message ?? `HTTP ${res.status}`, res.status);
    }
    if (json === null) {
      throw new ApiError('UNKNOWN_ERROR', `無法解析伺服器回應（HTTP ${res.status}）`, res.status);
    }
    return json as T;
  }

  if (!isEnvelope(json)) {
    throw new ApiError('UNKNOWN_ERROR', `無法解析伺服器回應（HTTP ${res.status}）`, res.status);
  }
  if (!json.success) {
    throw new ApiError(json.error.code, json.error.message, res.status);
  }
  return json.data as T;
}

function toQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export const api = {
  listShippingMethods(params: { enabled?: boolean; limit?: number; offset?: number } = {}, signal?: AbortSignal) {
    return request<Paged<ShippingMethod>>(`/api/v1/shipping/methods${toQuery(params)}`, { signal });
  },
  createShippingMethod(body: {
    code: string; name: string; provider: string; type: string; destinationKind: ShippingMethod['destinationKind'];
    feeCents: number; freeShippingThresholdCents?: number; enabled: boolean;
  }, idempotencyKey?: string) {
    return request<ShippingMethod>('/api/v1/shipping/methods', { method: 'POST', body, idempotent: true, idempotencyKey });
  },
  updateShippingMethod(id: string, body: {
    name?: string; provider?: string; type?: string; destinationKind?: ShippingMethod['destinationKind'];
    feeCents?: number; freeShippingThresholdCents?: number | null; enabled?: boolean;
  }, idempotencyKey?: string) {
    return request<ShippingMethod>(`/api/v1/shipping/methods/${id}`, { method: 'PATCH', body, idempotent: true, idempotencyKey });
  },
  getShipment(id: string, signal?: AbortSignal) {
    return request<Shipment>(`/api/v1/shipping/shipments/${id}`, { signal });
  },
  createShipment(body: { orderId: string; providerRef?: string; trackingNumber?: string }, idempotencyKey?: string) {
    return request<Shipment>('/api/v1/shipping/shipments', { method: 'POST', body, idempotent: true, idempotencyKey });
  },
  advanceShipmentStage(id: string, status: Exclude<Shipment['status'], 'created'>, idempotencyKey?: string) {
    return request<Shipment>(`/api/v1/shipping/shipments/${id}/stage`, { method: 'POST', body: { status }, idempotent: true, idempotencyKey });
  },
  getShipmentLabelInfo(id: string, signal?: AbortSignal) {
    return request<ShipmentLabelInfo>(`/api/v1/shipping/shipments/${id}/label`, { signal });
  },
  getEcpayLogisticsShipmentOperation(shipmentId: string, signal?: AbortSignal) {
    return request<EcpayLogisticsShipmentOperation | null>(
      `/api/v1/extensions/ecpay-logistics/queries/ext.ecpay-logistics.getShipmentOperation${toQuery({ shipmentId })}`, { signal },
    );
  },
  listEcpayLogisticsShipmentOperations(params: { status?: EcpayLogisticsShipmentOperation['status']; limit?: number } = {}, signal?: AbortSignal) {
    return request<{ items: EcpayLogisticsShipmentOperation[] }>(
      `/api/v1/extensions/ecpay-logistics/queries/ext.ecpay-logistics.listShipmentOperations${toQuery(params)}`, { signal },
    );
  },
  retryEcpayLogisticsShipment(shipmentId: string, idempotencyKey?: string) {
    return request<EcpayLogisticsShipmentOperation>(
      '/api/v1/extensions/ecpay-logistics/commands/ext.ecpay-logistics.retryShipment',
      { method: 'POST', body: { shipmentId }, idempotent: true, idempotencyKey },
    );
  },
  listProducts(params: { q?: string; status?: string; limit?: number; offset?: number }, signal?: AbortSignal) {
    return request<Paged<Product>>(`/api/v1/products${toQuery(params)}`, { signal });
  },
  createProduct(body: {
    sku: string;
    name: string;
    description?: string;
    priceCents: number;
    currency: string;
    status: Product['status'];
  }, idempotencyKey?: string) {
    return request<Product>('/api/v1/products', { method: 'POST', body, idempotent: true, idempotencyKey });
  },
  getProduct(id: string) {
    return request<Product>(`/api/v1/products/${id}`);
  },
  patchProduct(
    id: string,
    body: { name?: string; description?: string | null; priceCents?: number; status?: Product['status'] },
    idempotencyKey?: string,
  ) {
    return request<Product>(`/api/v1/products/${id}`, { method: 'PATCH', body, idempotent: true, idempotencyKey });
  },
  listInventory(params: { belowQuantity?: number; productIds?: string[]; limit?: number; offset?: number }, signal?: AbortSignal) {
    const { productIds, ...rest } = params;
    return request<Paged<Stock>>(
      `/api/v1/inventory${toQuery({ ...rest, productIds: productIds?.length ? productIds.join(',') : undefined })}`,
      { signal },
    );
  },
  getInventory(productId: string) {
    return request<Stock>(`/api/v1/inventory/${productId}`);
  },
  adjustInventory(body: { productId: string; delta: number; reason?: string; reference?: string }, idempotencyKey?: string) {
    const validReasons = ['restock', 'correction', 'damage', 'return', 'manual'];
    const reasonEnum = body.reason && validReasons.includes(body.reason) ? body.reason : 'manual';
    const ref = body.reference || (body.reason && !validReasons.includes(body.reason) ? body.reason : undefined);
    return request<Stock>('/api/v1/inventory/adjust', {
      method: 'POST',
      body: { productId: body.productId, delta: body.delta, reason: reasonEnum, reference: ref },
      idempotent: true,
      idempotencyKey,
    });
  },
  listOrders(params: { status?: Order['status']; limit?: number; offset?: number }, signal?: AbortSignal) {
    return request<Paged<Order>>(`/api/v1/orders${toQuery(params)}`, { signal });
  },
  getOrder(id: string) {
    return request<Order>(`/api/v1/orders/${id}`);
  },
  payOrder(id: string, idempotencyKey?: string) {
    return request<Order>(`/api/v1/orders/${id}/pay`, { method: 'POST', body: {}, idempotent: true, idempotencyKey });
  },
  cancelOrder(id: string, reason: string, idempotencyKey?: string) {
    return request<Order>(`/api/v1/orders/${id}/cancel`, {
      method: 'POST',
      body: { reason },
      idempotent: true, idempotencyKey,
    });
  },
  listRefunds(params: { orderId?: string; status?: Refund['status']; limit?: number; offset?: number }, signal?: AbortSignal) {
    return request<Paged<Refund>>(`/api/v1/refunds${toQuery(params)}`, { signal });
  },
  requestRefund(orderId: string, reason: string, idempotencyKey?: string) {
    return request<Refund>(`/api/v1/refunds/orders/${orderId}`, { method: 'POST', body: { reason }, idempotent: true, idempotencyKey });
  },
  retryRefund(id: string, idempotencyKey?: string) {
    return request<Refund>(`/api/v1/refunds/${id}/retry`, { method: 'POST', body: {}, idempotent: true, idempotencyKey });
  },
  listRmas(params: { orderId?: string; status?: Rma['status']; limit?: number; offset?: number }, signal?: AbortSignal) {
    return request<Paged<Rma>>(`/api/v1/rmas${toQuery(params)}`, { signal });
  },
  approveRma(id: string, note?: string, idempotencyKey?: string) {
    return request<Rma>(`/api/v1/rmas/${id}/approve`, { method: 'POST', body: note ? { note } : {}, idempotent: true, idempotencyKey });
  },
  requestRmaInformation(id: string, note: string, idempotencyKey?: string) {
    return request<Rma>(`/api/v1/rmas/${id}/request-information`, { method: 'POST', body: { note }, idempotent: true, idempotencyKey });
  },
  rejectRma(id: string, note: string, idempotencyKey?: string) {
    return request<Rma>(`/api/v1/rmas/${id}/reject`, { method: 'POST', body: { note }, idempotent: true, idempotencyKey });
  },
  receiveRma(id: string, lines: { rmaLineId: string; disposition: 'restock' | 'discard'; discardReason?: string }[], idempotencyKey?: string) {
    return request<Rma>(`/api/v1/rmas/${id}/receive`, { method: 'POST', body: { lines }, idempotent: true, idempotencyKey });
  },
  listLifecycleDeliveries(params: { orderId?: string; status?: LifecycleDelivery['status']; limit?: number; offset?: number }, signal?: AbortSignal) {
    return request<Paged<LifecycleDelivery>>(`/api/v1/notification-deliveries${toQuery(params)}`, { signal });
  },
  correctCustomerBirthday(id: string, body: { birthday: string; reason: string }, idempotencyKey?: string) {
    return request<Omit<AdminCustomer, 'email'>>(`/api/v1/customers/${id}/birthday`, { method: 'POST', body, idempotent: true, idempotencyKey });
  },
  getRewardSettings(signal?: AbortSignal) {
    return request<RewardSettings>('/api/v1/loyalty/settings', { signal });
  },
  updateRewardSettings(body: { accrualBasisPoints?: number; effectiveAfterDays?: number; expiresAfterDays?: number | null; expiryNoticeDays?: number }, idempotencyKey?: string) {
    return request<RewardSettings>('/api/v1/loyalty/settings', { method: 'PATCH', body, idempotent: true, idempotencyKey });
  },
  listTiers(signal?: AbortSignal) {
    return request<{ items: Tier[] }>('/api/v1/loyalty/tiers', { signal });
  },
  saveTier(body: Tier, idempotencyKey?: string) {
    return request<Tier>('/api/v1/loyalty/tiers', { method: 'PUT', body, idempotent: true, idempotencyKey });
  },
  removeTier(name: string, idempotencyKey?: string) {
    return request<{ items: Tier[] }>(`/api/v1/loyalty/tiers/${encodeURIComponent(name)}`, { method: 'DELETE', idempotent: true, idempotencyKey });
  },
  listInvoices(params: { orderId?: string; status?: Invoice['status']; limit?: number; offset?: number }, signal?: AbortSignal) {
    return request<Paged<Invoice>>(`/api/v1/invoices${toQuery(params)}`, { signal });
  },
  retryInvoiceIssue(id: string, idempotencyKey: string) {
    return request<Invoice>(`/api/v1/invoices/${id}/retry-issue`, { method: 'POST', body: {}, idempotent: true, idempotencyKey });
  },
  retryInvoiceVoid(id: string, idempotencyKey: string) {
    return request<Invoice>(`/api/v1/invoices/${id}/retry-void`, { method: 'POST', body: {}, idempotent: true, idempotencyKey });
  },
  requestRmaRefund(id: string, reason?: string, idempotencyKey?: string) {
    return request<Rma>(`/api/v1/rmas/${id}/request-refund`, { method: 'POST', body: reason ? { reason } : {}, idempotent: true, idempotencyKey });
  },
  listPromotions(params: { status?: string; activeAt?: string; limit?: number; offset?: number }, signal?: AbortSignal) {
    return request<Paged<Promotion>>(`/api/v1/promotions${toQuery(params)}`, { signal });
  },
  createPromotion(body: {
    name: string;
    rule: PromotionRule;
    priority: number;
    stackable: boolean;
    requiresCoupon?: boolean;
    startsAt?: string;
    endsAt?: string;
  }, idempotencyKey?: string) {
    return request<Promotion>('/api/v1/promotions', { method: 'POST', body, idempotent: true, idempotencyKey });
  },
  updatePromotion(
    id: string,
    body: { name?: string; rule?: PromotionRule; priority?: number; stackable?: boolean; startsAt?: string; endsAt?: string },
    idempotencyKey?: string,
  ) {
    return request<Promotion>(`/api/v1/promotions/${id}`, { method: 'PATCH', body, idempotent: true, idempotencyKey });
  },
  setPromotionStatus(id: string, status: Promotion['status'], idempotencyKey?: string) {
    return request<Promotion>(`/api/v1/promotions/${id}/status`, {
      method: 'POST',
      body: { status },
      idempotent: true, idempotencyKey,
    });
  },
  listCoupons(params: { status?: string; promotionId?: string; limit?: number; offset?: number }, signal?: AbortSignal) {
    return request<Paged<Coupon>>(`/api/v1/coupons${toQuery(params)}`, { signal });
  },
  createCoupon(body: {
    code: string;
    promotionId: string;
    partnerCode?: string;
    maxRedemptions?: number;
    perCustomerLimit: number | null;
    startsAt?: string;
    endsAt?: string;
  }, idempotencyKey?: string) {
    return request<Coupon>('/api/v1/coupons', { method: 'POST', body, idempotent: true, idempotencyKey });
  },
  issueCoupons(body: { promotionId: string; codePrefix?: string; expiresInDays?: number }, idempotencyKey?: string) {
    return request<IssueResult>('/api/v1/coupons/issue', { method: 'POST', body, idempotent: true, idempotencyKey });
  },
  setCouponStatus(id: string, status: Coupon['status'], idempotencyKey?: string) {
    return request<Coupon>(`/api/v1/coupons/${id}/status`, { method: 'POST', body: { status }, idempotent: true, idempotencyKey });
  },
  listCustomers(params: { q?: string; status?: string; limit?: number; offset?: number }, signal?: AbortSignal) {
    return request<Paged<AdminCustomer>>(`/api/v1/customers${toQuery(params)}`, { signal });
  },
  getCustomer(id: string, signal?: AbortSignal) {
    return request<AdminCustomerDetail>(`/api/v1/customers/${id}`, { signal });
  },
  customerLoyalty(id: string, signal?: AbortSignal) {
    return request<CustomerLoyalty>(`/api/v1/customers/${id}/loyalty`, { signal });
  },
  // 調帳會生出錢：冪等鍵由畫面固定住，連點兩下不會補兩次。
  adjustRewards(id: string, body: { amountCents: number; reason: string }, idempotencyKey: string) {
    return request<{ id: string }>(`/api/v1/customers/${id}/rewards`,
      { method: 'POST', body, idempotent: true, idempotencyKey });
  },
  adjustTierPoints(id: string, body: { points: number; reason: string }, idempotencyKey: string) {
    return request<{ points: number }>(`/api/v1/customers/${id}/tier-points`,
      { method: 'POST', body, idempotent: true, idempotencyKey });
  },
  setCustomerStatus(id: string, status: AdminCustomer['status'], idempotencyKey?: string) {
    return request<AdminCustomer>(`/api/v1/customers/${id}/status`, { method: 'POST', body: { status }, idempotent: true, idempotencyKey });
  },
  salesSummary(params: { from?: string; to?: string }, signal?: AbortSignal) {
    return request<SalesSummary>(`/api/v1/analytics/sales-summary${toQuery(dayRange(params))}`, { signal });
  },
  promotionPerformance(params: { from?: string; to?: string }, signal?: AbortSignal) {
    return request<{ currency: string; items: PromotionPerformance[] }>(
      `/api/v1/analytics/promotions${toQuery(dayRange(params))}`,
      { signal },
    );
  },
  partnerPerformance(params: { from?: string; to?: string }, signal?: AbortSignal) {
    return request<{ currency: string; items: AttributionSummary[] }>(
      `/api/v1/analytics/partners${toQuery(dayRange(params))}`,
      { signal },
    );
  },
  outstandingRewards(signal?: AbortSignal) {
    return request<OutstandingRewards>('/api/v1/analytics/outstanding-rewards', { signal });
  },
  listExtensions(signal?: AbortSignal) {
    return request<{ items: ExtensionInfo[] }>('/api/v1/extensions', { signal });
  },
  listDeliveries(limit = 50, signal?: AbortSignal) {
    return request<{ items: Delivery[] }>(
      `/api/v1/extensions/demo-erp/queries/ext.demo-erp.listDeliveries?limit=${limit}`,
      { signal },
    );
  },
  inspectDeliveryPayload(orderId: string, signal?: AbortSignal) {
    return request<DeliveryPayload>(
      `/api/v1/extensions/demo-erp/queries/ext.demo-erp.inspectDeliveryPayload${toQuery({ orderId })}`,
      { signal },
    );
  },
  resendOrder(orderId: string, idempotencyKey: string) {
    return request<{ orderId: string; status: string; attempts: number; jobId: string }>(
      '/api/v1/extensions/demo-erp/commands/ext.demo-erp.resendOrder',
      { method: 'POST', body: { orderId }, idempotent: true, idempotencyKey },
    );
  },
  healthDependencies(signal?: AbortSignal) {
    return request<HealthReport>('/health/dependencies', { raw: true, signal });
  },
  listDeadJobs(params: { limit?: number; offset?: number }, signal?: AbortSignal) {
    return request<Paged<DeadJob>>(`/api/v1/system/jobs/dead${toQuery(params)}`, { signal });
  },
  retryDeadJob(jobId: string, idempotencyKey: string) {
    return request<{ jobId: string; status: string }>(
      `/api/v1/system/jobs/dead/${jobId}/retry`,
      { method: 'POST', body: {}, idempotent: true, idempotencyKey },
    );
  },
  /** Theme 決定哪些配圖存在（ADR 0034），這份清單只能問 API，不能寫死在畫面裡。 */
  contentImageKeys(signal?: AbortSignal) {
    return request<{ keys: string[] }>('/api/v1/content/articles/image-keys', { signal });
  },
  listArticles(params: { kind?: Article['kind']; status?: Article['status']; limit?: number; offset?: number } = {}, signal?: AbortSignal) {
    return request<Paged<Article>>(`/api/v1/content/articles${toQuery(params)}`, { signal });
  },
  getArticle(id: string) {
    return request<Article>(`/api/v1/content/articles/${id}`);
  },
  createArticle(body: {
    kind: Article['kind'];
    slug: string;
    title: string;
    summary?: string;
    section?: string;
    body?: ArticleBlock[];
    imageKey?: string | null;
    position?: number;
  }, idempotencyKey?: string) {
    return request<Article>('/api/v1/content/articles', { method: 'POST', body, idempotent: true, idempotencyKey });
  },
  updateArticle(
    id: string,
    body: {
      slug?: string;
      title?: string;
      summary?: string;
      section?: string;
      body?: ArticleBlock[];
      imageKey?: string | null;
      position?: number;
    }, idempotencyKey?: string,
  ) {
    return request<Article>(`/api/v1/content/articles/${id}`, { method: 'POST', body, idempotent: true, idempotencyKey });
  },
  publishArticle(id: string, idempotencyKey?: string) {
    return request<Article>(`/api/v1/content/articles/${id}/publish`, { method: 'POST', body: {}, idempotent: true, idempotencyKey });
  },
  unpublishArticle(id: string, idempotencyKey?: string) {
    return request<Article>(`/api/v1/content/articles/${id}/unpublish`, { method: 'POST', body: {}, idempotent: true, idempotencyKey });
  },
  deleteArticle(id: string, idempotencyKey?: string) {
    return request<Article>(`/api/v1/content/articles/${id}`, { method: 'DELETE', idempotent: true, idempotencyKey });
  },
  listContactMessages(params: { status?: ContactMessage['status']; limit?: number; offset?: number } = {}, signal?: AbortSignal) {
    return request<Paged<ContactMessage>>(`/api/v1/content/contact-messages${toQuery(params)}`, { signal });
  },
  getContactMessage(id: string) {
    return request<ContactMessage>(`/api/v1/content/contact-messages/${id}`);
  },
  markContactMessageHandled(id: string, idempotencyKey: string) {
    return request<ContactMessage>(`/api/v1/content/contact-messages/${id}/handled`, {
      method: 'POST',
      body: {},
      idempotent: true,
      idempotencyKey,
    });
  },
  // ---- 後台操作者帳號與 API token（B13 片4）----
  listOperators(params: { limit?: number; offset?: number } = {}, signal?: AbortSignal) {
    return request<Paged<Operator>>(`/api/v1/users${toQuery(params)}`, { signal });
  },
  createOperator(body: { email: string; password: string; displayName: string; role: string }, idempotencyKey?: string) {
    return request<Operator>('/api/v1/users', { method: 'POST', body, idempotent: true, idempotencyKey });
  },
  setOperatorStatus(id: string, status: Operator['status'], idempotencyKey?: string) {
    return request<Operator>(`/api/v1/users/${id}/status`, { method: 'POST', body: { status }, idempotent: true, idempotencyKey });
  },
  listApiTokens(signal?: AbortSignal) {
    return request<{ items: ApiToken[] }>('/api/v1/system/api-tokens', { signal });
  },
  issueApiToken(body: { name: string; role: string; ttlDays: number }, idempotencyKey?: string) {
    return request<IssuedApiToken>('/api/v1/system/api-tokens', { method: 'POST', body, idempotent: true, idempotencyKey });
  },
  revokeApiToken(name: string, idempotencyKey?: string) {
    return request<ApiToken>(`/api/v1/system/api-tokens/${encodeURIComponent(name)}/revoke`, { method: 'POST', body: {}, idempotent: true, idempotencyKey });
  },

  // ---- 站內收件匣與帳號自助（B13 片5）----
  listInbox(params: { limit?: number; offset?: number; unreadOnly?: boolean } = {}, signal?: AbortSignal) {
    return request<Paged<InboxNotification> & { unread: number }>(`/api/v1/notifications${toQuery(params)}`, { signal });
  },
  markInboxRead(ids: string[], idempotencyKey?: string) {
    return request<{ updated: number; readAt: string }>('/api/v1/notifications/read', { method: 'POST', body: { ids }, idempotent: true, idempotencyKey });
  },
  changePassword(body: { currentPassword: string; newPassword: string }) {
    return request<{ changed: true }>('/api/v1/auth/change-password', { method: 'POST', body, withAuth: false });
  },
  changeEmail(body: { currentPassword: string; newEmail: string }) {
    return request<{ accepted: true }>('/api/v1/auth/change-email', { method: 'POST', body, withAuth: false });
  },
  resendVerification() {
    return request<{ accepted: true }>('/api/v1/auth/resend-verification', { method: 'POST', body: {}, withAuth: false });
  },
  revokeOtherSessions() {
    return request<{ accepted: true }>('/api/v1/auth/revoke-other-sessions', { method: 'POST', body: {}, withAuth: false });
  },
  mfaStatus(signal?: AbortSignal) {
    return request<MfaStatus>('/api/v1/auth/mfa', { withAuth: false, signal });
  },
  mfaEnroll() {
    return request<{ secret: string; uri: string }>('/api/v1/auth/mfa/enroll', { method: 'POST', body: {}, withAuth: false });
  },
  mfaConfirm(code: string) {
    return request<{ recoveryCodes: string[] }>('/api/v1/auth/mfa/confirm', { method: 'POST', body: { code }, withAuth: false });
  },
  mfaRecoveryCodes(code: string) {
    return request<{ recoveryCodes: string[] }>('/api/v1/auth/mfa/recovery-codes', { method: 'POST', body: { code }, withAuth: false });
  },
  mfaDisable(body: { currentPassword: string; code: string }) {
    return request<{ accepted: true }>('/api/v1/auth/mfa/disable', { method: 'POST', body, withAuth: false });
  },

  login(email: string, password: string, second?: { mfaCode?: string; recoveryCode?: string }) {
    return request<LoginResult>('/api/v1/auth/login', {
      method: 'POST', body: { email, password, ...second }, withAuth: false,
    });
  },
  logout() {
    return request<void>('/api/v1/auth/logout', { method: 'POST', body: {}, withAuth: false });
  },
  me() {
    return request<CurrentUser>('/api/v1/auth/me', { withAuth: false });
  },
};

/** date input 只有到日，補上時間讓區間包含「到」那一整天。 */
function dayRange(params: { from?: string; to?: string }) {
  return {
    from: params.from ? `${params.from}T00:00:00` : undefined,
    to: params.to ? `${params.to}T23:59:59.999` : undefined,
  };
}

/** 依 currency 格式化 cents 金額 */
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat(displayLocale, { style: 'currency', currency }).format(cents / 100);
}
