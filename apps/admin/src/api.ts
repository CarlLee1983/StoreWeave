// API 型別與 fetch wrapper。所有請求集中在這裡，畫面元件不直接呼叫 fetch。

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

export type OrderLine = {
  id: string;
  productId: string;
  sku: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
  discountCents: number;
};

export type OrderAdjustment = {
  source: 'promotion';
  sourceId: string;
  name: string;
  /** 折扣為負數。 */
  amountCents: number;
};

export type Order = {
  id: string;
  number: string;
  status: 'pending' | 'payment_processing' | 'paid' | 'cancelled' | 'expired';
  currency: string;
  customerEmail: string;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  lines: OrderLine[];
  adjustments: OrderAdjustment[];
  placedAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
  expiresAt: string | null;
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
    recipient: string; phone: string; postcode: string; city: string; line1: string; line2: string | null;
  } | null;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
};

export type AdminCustomerDetail = AdminCustomer & {
  orders: { id: string; number: string; status: string; currency: string; totalCents: number; placedAt: string }[];
};

export type CustomerLoyalty = {
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

export type CurrentUser = { id: string; email: string; displayName: string; role: string };

export type Paged<T> = { items: T[]; total: number };

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
export class ApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type Envelope<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string } };

function isEnvelope(value: unknown): value is Envelope<unknown> {
  return typeof value === 'object' && value !== null && 'success' in value;
}

/** 從 document.cookie 讀 commerce_csrf；帳號登入路徑靠 cookie 驗證的非 GET 請求需要這個 header。 */
function getCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)commerce_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; idempotent?: boolean; withAuth?: boolean; raw?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, idempotent = false, withAuth = true, raw = false } = options;
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
    headers['Idempotency-Key'] = crypto.randomUUID();
  }

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const json: unknown = await res.json().catch(() => null);

  // 健康端點回的是原始物件而不是 API 信封，但失敗時仍會回信封（例如 session 過期的 401），
  // 所以這裡必須看狀態碼——否則錯誤信封會被當成健康報告傳下去，畫面在 render 時才炸。
  if (raw) {
    if (!res.ok) {
      const error = isEnvelope(json) && !json.success ? json.error : null;
      throw new ApiError(error?.code ?? 'UNKNOWN_ERROR', error?.message ?? `HTTP ${res.status}`);
    }
    if (json === null) {
      throw new ApiError('UNKNOWN_ERROR', `無法解析伺服器回應（HTTP ${res.status}）`);
    }
    return json as T;
  }

  if (!isEnvelope(json)) {
    throw new ApiError('UNKNOWN_ERROR', `無法解析伺服器回應（HTTP ${res.status}）`);
  }
  if (!json.success) {
    throw new ApiError(json.error.code, json.error.message);
  }
  return json.data as T;
}

function toQuery(params: Record<string, string | number | undefined>): string {
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
  listProducts(params: { q?: string; status?: string; limit?: number; offset?: number }) {
    return request<Paged<Product>>(`/api/v1/products${toQuery(params)}`);
  },
  createProduct(body: {
    sku: string;
    name: string;
    description?: string;
    priceCents: number;
    currency: string;
    status: Product['status'];
  }) {
    return request<Product>('/api/v1/products', { method: 'POST', body, idempotent: true });
  },
  getProduct(id: string) {
    return request<Product>(`/api/v1/products/${id}`);
  },
  patchProduct(
    id: string,
    body: { name?: string; description?: string; priceCents?: number; status?: Product['status'] },
  ) {
    return request<Product>(`/api/v1/products/${id}`, { method: 'PATCH', body, idempotent: true });
  },
  listInventory(params: { belowQuantity?: number; limit?: number; offset?: number }) {
    return request<Paged<Stock>>(`/api/v1/inventory${toQuery(params)}`);
  },
  getInventory(productId: string) {
    return request<Stock>(`/api/v1/inventory/${productId}`);
  },
  adjustInventory(body: { productId: string; delta: number; reason: string; reference?: string }) {
    return request<Stock>('/api/v1/inventory/adjust', { method: 'POST', body, idempotent: true });
  },
  listOrders(params: { status?: string; limit?: number; offset?: number }) {
    return request<Paged<Order>>(`/api/v1/orders${toQuery(params)}`);
  },
  getOrder(id: string) {
    return request<Order>(`/api/v1/orders/${id}`);
  },
  createOrder(body: {
    customerEmail: string;
    lines: { productId: string; quantity: number }[];
    currency?: string;
  }) {
    return request<Order>('/api/v1/orders', { method: 'POST', body, idempotent: true });
  },
  payOrder(id: string) {
    return request<Order>(`/api/v1/orders/${id}/pay`, { method: 'POST', body: {}, idempotent: true });
  },
  cancelOrder(id: string, reason: string) {
    return request<Order>(`/api/v1/orders/${id}/cancel`, {
      method: 'POST',
      body: { reason },
      idempotent: true,
    });
  },
  listPromotions(params: { status?: string; activeAt?: string; limit?: number; offset?: number }) {
    return request<Paged<Promotion>>(`/api/v1/promotions${toQuery(params)}`);
  },
  createPromotion(body: {
    name: string;
    rule: PromotionRule;
    priority: number;
    stackable: boolean;
    requiresCoupon?: boolean;
    startsAt?: string;
    endsAt?: string;
  }) {
    return request<Promotion>('/api/v1/promotions', { method: 'POST', body, idempotent: true });
  },
  updatePromotion(
    id: string,
    body: { name?: string; rule?: PromotionRule; priority?: number; stackable?: boolean; startsAt?: string; endsAt?: string },
  ) {
    return request<Promotion>(`/api/v1/promotions/${id}`, { method: 'PATCH', body, idempotent: true });
  },
  setPromotionStatus(id: string, status: Promotion['status']) {
    return request<Promotion>(`/api/v1/promotions/${id}/status`, {
      method: 'POST',
      body: { status },
      idempotent: true,
    });
  },
  listCoupons(params: { status?: string; promotionId?: string; limit?: number; offset?: number }) {
    return request<Paged<Coupon>>(`/api/v1/coupons${toQuery(params)}`);
  },
  createCoupon(body: {
    code: string;
    promotionId: string;
    partnerCode?: string;
    maxRedemptions?: number;
    perCustomerLimit: number | null;
    startsAt?: string;
    endsAt?: string;
  }) {
    return request<Coupon>('/api/v1/coupons', { method: 'POST', body, idempotent: true });
  },
  issueCoupons(body: { promotionId: string; codePrefix?: string; expiresInDays?: number }) {
    return request<IssueResult>('/api/v1/coupons/issue', { method: 'POST', body, idempotent: true });
  },
  setCouponStatus(id: string, status: Coupon['status']) {
    return request<Coupon>(`/api/v1/coupons/${id}/status`, { method: 'POST', body: { status }, idempotent: true });
  },
  listCustomers(params: { q?: string; status?: string; limit?: number; offset?: number }) {
    return request<Paged<AdminCustomer>>(`/api/v1/customers${toQuery(params)}`);
  },
  getCustomer(id: string) {
    return request<AdminCustomerDetail>(`/api/v1/customers/${id}`);
  },
  customerLoyalty(id: string) {
    return request<CustomerLoyalty>(`/api/v1/customers/${id}/loyalty`);
  },
  adjustRewards(id: string, body: { amountCents: number; reason: string }) {
    return request<{ id: string }>(`/api/v1/customers/${id}/rewards`, { method: 'POST', body, idempotent: true });
  },
  adjustTierPoints(id: string, body: { points: number; reason: string }) {
    return request<{ points: number }>(`/api/v1/customers/${id}/tier-points`, { method: 'POST', body, idempotent: true });
  },
  setCustomerStatus(id: string, status: AdminCustomer['status']) {
    return request<AdminCustomer>(`/api/v1/customers/${id}/status`, { method: 'POST', body: { status }, idempotent: true });
  },
  salesSummary(params: { from?: string; to?: string }) {
    // date input 只有到日，這裡補上時間讓區間包含「到」那一整天
    return request<SalesSummary>(
      `/api/v1/analytics/sales-summary${toQuery({
        from: params.from ? `${params.from}T00:00:00` : undefined,
        to: params.to ? `${params.to}T23:59:59.999` : undefined,
      })}`,
    );
  },
  listExtensions() {
    return request<{ items: ExtensionInfo[] }>('/api/v1/extensions');
  },
  listDeliveries(limit = 50) {
    return request<{ items: Delivery[] }>(
      `/api/v1/extensions/demo-erp/queries/ext.demo-erp.listDeliveries?limit=${limit}`,
    );
  },
  inspectDeliveryPayload(orderId: string) {
    return request<DeliveryPayload>(
      `/api/v1/extensions/demo-erp/queries/ext.demo-erp.inspectDeliveryPayload${toQuery({ orderId })}`,
    );
  },
  resendOrder(orderId: string) {
    return request<{ orderId: string; status: string; attempts: number; jobId: string }>(
      '/api/v1/extensions/demo-erp/commands/ext.demo-erp.resendOrder',
      { method: 'POST', body: { orderId }, idempotent: true },
    );
  },
  healthDependencies() {
    return request<HealthReport>('/health/dependencies', { raw: true });
  },
  listDeadJobs(params: { limit?: number; offset?: number }) {
    return request<Paged<DeadJob>>(`/api/v1/system/jobs/dead${toQuery(params)}`);
  },
  retryDeadJob(jobId: string) {
    return request<{ jobId: string; status: string }>(
      `/api/v1/system/jobs/dead/${jobId}/retry`,
      { method: 'POST', body: {}, idempotent: true },
    );
  },
  login(email: string, password: string) {
    return request<CurrentUser>('/api/v1/auth/login', { method: 'POST', body: { email, password }, withAuth: false });
  },
  logout() {
    return request<void>('/api/v1/auth/logout', { method: 'POST', body: {}, withAuth: false });
  },
  me() {
    return request<CurrentUser>('/api/v1/auth/me', { withAuth: false });
  },
};

/** 依 currency 格式化 cents 金額 */
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat(displayLocale, { style: 'currency', currency }).format(cents / 100);
}
