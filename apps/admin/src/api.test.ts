/**
 * @vitest-environment-options { "url": "https://admin.example.test/" }
 *
 * 這個檔案跑在 https 的 jsdom 上：`__Host-` 前綴的 cookie 需要 Secure，
 * 而 Secure 在 http 頁面上會被 jsdom（與真正的瀏覽器）拒收。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api';

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function clearCookies() {
  for (const entry of document.cookie.split(';')) {
    const name = entry.split('=')[0]?.trim();
    // 帶 Secure：沒有它，`__Host-` 開頭的那一張連刪除都會被拒絕，會漏到下一條測試。
    if (name) document.cookie = `${name}=; Max-Age=0; path=/; Secure`;
  }
}

function sentHeaders(): Record<string, string> {
  return (fetch as unknown as { mock: { calls: [string, { headers: Record<string, string> }][] } })
    .mock.calls[0][1].headers;
}

/**
 * cookie 的名字在 https 部署上會多一個 `__Host-` 前綴，本機 http 開發沒有（ADR 0023），
 * 而這支前端建置時不知道自己會跑在哪一種，因此兩個都認得。
 */
describe('CSRF token 從 cookie 讀出來', () => {
  afterEach(clearCookies);

  it('兩張都在時取帶前綴的那一張——它是子網域蓋不掉的那一張', async () => {
    mockFetch(200, { success: true, data: null });
    document.cookie = 'commerce_csrf=bare-value; path=/';
    document.cookie = '__Host-commerce_csrf=prefixed-value; path=/; Secure';

    await api.logout();

    expect(sentHeaders()['x-csrf-token']).toBe('prefixed-value');
  });

  it('只有裸名時就用裸名——裸名的比對不會誤匹配到前綴名的那一張', async () => {
    mockFetch(200, { success: true, data: null });
    document.cookie = 'commerce_csrf=bare-value; path=/';

    await api.logout();

    expect(sentHeaders()['x-csrf-token']).toBe('bare-value');
  });

  it('只有前綴名時也讀得到', async () => {
    mockFetch(200, { success: true, data: null });
    document.cookie = '__Host-commerce_csrf=prefixed-value; path=/; Secure';

    await api.logout();

    expect(sentHeaders()['x-csrf-token']).toBe('prefixed-value');
  });

  it('一張都沒有時不送這個 header', async () => {
    mockFetch(200, { success: true, data: null });

    await api.logout();

    expect(sentHeaders()).not.toHaveProperty('x-csrf-token');
  });
});

describe('健康端點的原始回應', () => {
  it('session 過期時丟出 ApiError，而不是把錯誤信封當成健康報告', async () => {
    mockFetch(401, { success: false, error: { code: 'UNAUTHENTICATED', message: 'Missing bearer token' } });

    await expect(api.healthDependencies()).rejects.toBeInstanceOf(ApiError);
    await expect(api.healthDependencies()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('成功時回傳原始物件', async () => {
    mockFetch(200, { status: 'ok', checks: [{ name: 'postgres', status: 'pass' }] });

    await expect(api.healthDependencies()).resolves.toMatchObject({ status: 'ok' });
  });
});

describe('Ticket 87 request metadata', () => {
  it('forwards a query AbortSignal and keeps an explicit idempotency key', async () => {
    mockFetch(200, { success: true, data: { items: [], total: 0 } });
    const controller = new AbortController();
    await api.listProducts({ limit: 20, offset: 0 }, controller.signal);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].signal).toBe(controller.signal);

    mockFetch(200, { success: true, data: null });
    await api.createProduct({ sku: 'SKU', name: 'Name', priceCents: 1, currency: 'TWD', status: 'draft' }, 'same-key');
    expect(sentHeaders()['Idempotency-Key']).toBe('same-key');
  });

  it('retains HTTP status on ApiError without changing the two-argument constructor', async () => {
    mockFetch(409, { success: false, error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: 'pending' } });
    await expect(api.createProduct({ sku: 'SKU', name: 'Name', priceCents: 1, currency: 'TWD', status: 'draft' })).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_IN_PROGRESS' });
    expect(new ApiError('X', 'message')).toMatchObject({ status: 0, code: 'X' });
  });
});

describe('Ticket 88 commerce request metadata', () => {
  it('forwards AbortSignal for every migrated read', async () => {
    const reads: [string, (signal: AbortSignal) => Promise<unknown>][] = [
      ['promotions', (signal) => api.listPromotions({ status: 'active', limit: 100, offset: 0 }, signal)],
      ['coupons', (signal) => api.listCoupons({ status: 'issued', promotionId: 'promotion', limit: 100, offset: 0 }, signal)],
      ['reward settings', (signal) => api.getRewardSettings(signal)],
      ['tiers', (signal) => api.listTiers(signal)],
      ['articles', (signal) => api.listArticles({ kind: 'news', status: 'draft', limit: 100, offset: 0 }, signal)],
      ['article image keys', (signal) => api.contentImageKeys(signal)],
      ['orders', (signal) => api.listOrders({ status: 'paid', limit: 50, offset: 0 }, signal)],
      ['refunds', (signal) => api.listRefunds({ orderId: 'order', status: 'requested', limit: 50, offset: 0 }, signal)],
      ['rmas', (signal) => api.listRmas({ orderId: 'order', status: 'approved', limit: 50, offset: 0 }, signal)],
      ['customers', (signal) => api.listCustomers({ q: 'buyer', status: 'active', limit: 50, offset: 0 }, signal)],
      ['customer detail', (signal) => api.getCustomer('customer', signal)],
      ['customer loyalty', (signal) => api.customerLoyalty('customer', signal)],
      ['shipping methods', (signal) => api.listShippingMethods({ enabled: true, limit: 100, offset: 0 }, signal)],
      ['shipment', (signal) => api.getShipment('shipment', signal)],
      ['shipment label', (signal) => api.getShipmentLabelInfo('shipment', signal)],
      ['extensions', (signal) => api.listExtensions(signal)],
      ['shipment operation', (signal) => api.getEcpayLogisticsShipmentOperation('shipment', signal)],
      ['shipment operations', (signal) => api.listEcpayLogisticsShipmentOperations({ status: 'failed', limit: 50 }, signal)],
      ['analytics sales summary', (signal) => api.salesSummary({ from: '2026-01-01', to: '2026-01-31' }, signal)],
      ['promotion performance', (signal) => api.promotionPerformance({ from: '2026-01-01', to: '2026-01-31' }, signal)],
      ['partner performance', (signal) => api.partnerPerformance({ from: '2026-01-01', to: '2026-01-31' }, signal)],
      ['outstanding rewards', (signal) => api.outstandingRewards(signal)],
      ['notification deliveries', (signal) => api.listLifecycleDeliveries({ orderId: 'order', status: 'failed', limit: 50, offset: 0 }, signal)],
      ['invoices', (signal) => api.listInvoices({ status: 'issue_failed', limit: 50, offset: 0 }, signal)],
      ['ERP deliveries', (signal) => api.listDeliveries(50, signal)],
      ['ERP payload', (signal) => api.inspectDeliveryPayload('order', signal)],
      ['health dependencies', (signal) => api.healthDependencies(signal)],
      ['dead jobs', (signal) => api.listDeadJobs({ limit: 50, offset: 0 }, signal)],
      ['contact messages', (signal) => api.listContactMessages({ status: 'new', limit: 100, offset: 0 }, signal)],
    ];
    for (const [name, read] of reads) {
      mockFetch(200, { success: true, data: { items: [], total: 0 } });
      const controller = new AbortController();
      await read(controller.signal);
      expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].signal, name).toBe(controller.signal);
    }
  });

  it('forwards every supplied stable key for migrated commands', async () => {
    const commands: [string, () => Promise<unknown>][] = [
      ['create-promotion', () => api.createPromotion({ name: 'promotion', rule: { type: 'order_percentage', percentOffBasisPoints: 100 }, priority: 0, stackable: false }, 'create-promotion')],
      ['update-promotion', () => api.updatePromotion('promotion', { name: 'promotion' }, 'update-promotion')],
      ['promotion-status', () => api.setPromotionStatus('promotion', 'active', 'promotion-status')],
      ['create-coupon', () => api.createCoupon({ code: 'CODE', promotionId: 'promotion', perCustomerLimit: null }, 'create-coupon')],
      ['issue-coupon', () => api.issueCoupons({ promotionId: 'promotion' }, 'issue-coupon')],
      ['coupon-status', () => api.setCouponStatus('coupon', 'void', 'coupon-status')],
      ['reward-settings', () => api.updateRewardSettings({ accrualBasisPoints: 100 }, 'reward-settings')],
      ['save-tier', () => api.saveTier({ name: 'gold', thresholdPoints: 1, multiplierBasisPoints: 10000 }, 'save-tier')],
      ['remove-tier', () => api.removeTier('gold', 'remove-tier')],
      ['create-article', () => api.createArticle({ kind: 'news', slug: 'article', title: 'Article' }, 'create-article')],
      ['update-article', () => api.updateArticle('article', { title: 'Article' }, 'update-article')],
      ['publish-article', () => api.publishArticle('article', 'publish-article')],
      ['unpublish-article', () => api.unpublishArticle('article', 'unpublish-article')],
      ['delete-article', () => api.deleteArticle('article', 'delete-article')],
      ['pay', () => api.payOrder('order', 'pay')],
      ['cancel', () => api.cancelOrder('order', 'reason', 'cancel')],
      ['refund', () => api.requestRefund('order', 'reason', 'refund')],
      ['retry-refund', () => api.retryRefund('refund', 'retry-refund')],
      ['approve-rma', () => api.approveRma('rma', undefined, 'approve-rma')],
      ['information-rma', () => api.requestRmaInformation('rma', 'reason', 'information-rma')],
      ['reject-rma', () => api.rejectRma('rma', 'reason', 'reject-rma')],
      ['receive-rma', () => api.receiveRma('rma', [{ rmaLineId: 'line', disposition: 'discard', discardReason: 'reason' }], 'receive-rma')],
      ['rma-refund', () => api.requestRmaRefund('rma', 'reason', 'rma-refund')],
      ['reward', () => api.adjustRewards('customer', { amountCents: 1, reason: 'reason' }, 'reward')],
      ['birthday', () => api.correctCustomerBirthday('customer', { birthday: '2000-01-01', reason: 'reason' }, 'birthday')],
      ['tier-points', () => api.adjustTierPoints('customer', { points: 1, reason: 'reason' }, 'tier-points')],
      ['customer-status', () => api.setCustomerStatus('customer', 'disabled', 'customer-status')],
      ['create-method', () => api.createShippingMethod({ code: 'method', name: 'Method', provider: 'manual', type: 'home', destinationKind: 'taiwan_home', feeCents: 0, enabled: true }, 'create-method')],
      ['update-method', () => api.updateShippingMethod('method', { name: 'Method' }, 'update-method')],
      ['shipment', () => api.createShipment({ orderId: 'order' }, 'shipment')],
      ['advance-shipment', () => api.advanceShipmentStage('shipment', 'shipped', 'advance-shipment')],
      ['retry-ecpay', () => api.retryEcpayLogisticsShipment('shipment', 'retry-ecpay')],
      ['ERP resend', () => api.resendOrder('order', 'ERP resend')],
      ['dead-job retry', () => api.retryDeadJob('job', 'dead-job retry')],
      ['invoice issue retry', () => api.retryInvoiceIssue('invoice', 'invoice issue retry')],
      ['invoice void retry', () => api.retryInvoiceVoid('invoice', 'invoice void retry')],
      ['contact handled', () => api.markContactMessageHandled('message', 'contact handled')],
    ];
    for (const [key, command] of commands) {
      mockFetch(200, { success: true, data: null });
      await command();
      expect(sentHeaders()['Idempotency-Key']).toBe(key);
    }
  });
});
