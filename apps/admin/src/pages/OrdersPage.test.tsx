import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render as baseRender, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { OrdersPage } from './OrdersPage';
import { I18nProvider } from '../i18n';
import { ApiError, api, type Order, type Refund } from '../api';
import { createAdminQueryClient } from '../query';
import { AdminOperationProvider, createAdminOperationStore } from '../admin-operations';

const render = (ui: Parameters<typeof baseRender>[0], store = createAdminOperationStore()) => baseRender(<QueryClientProvider client={createAdminQueryClient()}><AdminOperationProvider value={store}>{ui}</AdminOperationProvider></QueryClientProvider>);

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { listOrders: vi.fn(), payOrder: vi.fn(), cancelOrder: vi.fn(), listRefunds: vi.fn(), requestRefund: vi.fn(), retryRefund: vi.fn(), listRmas: vi.fn(), approveRma: vi.fn(), requestRmaInformation: vi.fn(), rejectRma: vi.fn(), receiveRma: vi.fn(), requestRmaRefund: vi.fn() } };
});

const order: Order = {
  id: '55555555-5555-4555-8555-555555555555',
  number: 'SW-1001',
  status: 'pending',
  currency: 'TWD',
  customerEmail: 'buyer@example.com',
  subtotalCents: 150_000,
  discountCents: 10_000,
  shippingCents: 0,
  taxCents: 0,
  totalCents: 140_000,
  lines: [
    {
      id: 'line-1',
      productId: '66666666-6666-4666-8666-666666666666',
      sku: 'TEA-001',
      name: '高山烏龍',
      unitPriceCents: 50_000,
      quantity: 3,
      lineTotalCents: 150_000,
      discountCents: 10_000,
    },
  ],
  adjustments: [{ source: 'promotion', sourceId: 'promo-1', name: '滿千折百', amountCents: -10_000 }],
  delivery: null,
  placedAt: '2026-08-22T00:00:00.000Z',
  paidAt: null,
  cancelledAt: null,
  expiresAt: null,
};

beforeEach(() => {
  localStorage.setItem('storeweave.admin.locale', 'zh-TW');
  vi.mocked(api.listOrders).mockReset().mockResolvedValue({ items: [order], total: 1 });
  vi.mocked(api.listRefunds).mockReset().mockResolvedValue({ items: [], total: 0 });
  vi.mocked(api.requestRefund).mockReset();
  vi.mocked(api.retryRefund).mockReset();
  vi.mocked(api.listRmas).mockReset().mockResolvedValue({ items: [], total: 0 });
  vi.mocked(api.rejectRma).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(api.requestRmaInformation).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(api.approveRma).mockReset().mockResolvedValue(undefined as never);
});

const requestedRma = {
  id: 'rma-1', orderId: order.id, customerId: 'customer-1', status: 'requested' as const,
  resolution: 'refund_and_reorder' as const, reason: '瑕疵', staffNote: null, refundId: null,
  receivedAt: null, completedAt: null, createdAt: order.placedAt, updatedAt: order.placedAt,
  lines: [{ id: 'rma-line-1', orderLineId: order.lines[0].id, productId: order.lines[0].productId, sku: 'TEA-001', name: '高山烏龍', quantity: 1, unitPriceCents: 50_000, lineTotalCents: 50_000, discountCents: 0, disposition: null, discardReason: null }],
};

describe('退貨佇列的操作密度', () => {
  beforeEach(() => {
    vi.mocked(api.listRmas).mockResolvedValue({ items: [requestedRma], total: 1 });
  });

  it('列上只留核准，補件與拒絕收在 ⋯ 選單裡', async () => {
    const user = userEvent.setup();
    render(<I18nProvider><OrdersPage /></I18nProvider>);
    expect(await screen.findByRole('button', { name: '核准' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '拒絕' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    expect(await screen.findByRole('menuitem', { name: '要求補件' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '拒絕' })).toBeInTheDocument();
  });

  it('拒絕原因用頁內對話框收，不用會卡住整個分頁的 window.prompt', async () => {
    const user = userEvent.setup();
    const prompt = vi.spyOn(window, 'prompt');
    render(<I18nProvider><OrdersPage /></I18nProvider>);
    await screen.findByRole('button', { name: '核准' });

    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    await user.click(await screen.findByRole('menuitem', { name: '拒絕' }));

    const dialog = await screen.findByRole('dialog', { name: /拒絕/ });
    expect(prompt).not.toHaveBeenCalled();
    await user.type(screen.getByRole('textbox'), '不符合退貨條件');
    await user.click(within(dialog).getByRole('button', { name: '拒絕' }));

    await waitFor(() => expect(api.rejectRma).toHaveBeenCalledWith('rma-1', '不符合退貨條件', expect.any(String)));
  });

  it('沒填原因就不送出：沒有理由的拒絕事後查不到帳', async () => {
    const user = userEvent.setup();
    render(<I18nProvider><OrdersPage /></I18nProvider>);
    await screen.findByRole('button', { name: '核准' });

    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    await user.click(await screen.findByRole('menuitem', { name: '拒絕' }));
    const dialog = await screen.findByRole('dialog', { name: /拒絕/ });
    await user.click(within(dialog).getByRole('button', { name: '拒絕' }));

    expect(api.rejectRma).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /拒絕/ })).toBeInTheDocument();
  });

  it('對話框按 Esc 收起，不會誤送出', async () => {
    const user = userEvent.setup();
    render(<I18nProvider><OrdersPage /></I18nProvider>);
    await screen.findByRole('button', { name: '核准' });

    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    await user.click(await screen.findByRole('menuitem', { name: '要求補件' }));
    await screen.findByRole('dialog', { name: /補件/ });

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /補件/ })).not.toBeInTheDocument());
    expect(api.requestRmaInformation).not.toHaveBeenCalled();
  });
});

describe('OrdersPage', () => {
  it('退款初始讀取中或失敗時不允許新退款', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listOrders).mockResolvedValue({ items: [{ ...order, status: 'paid' as const }], total: 1 });
    let release!: (value: { items: Refund[]; total: number }) => void;
    vi.mocked(api.listRefunds).mockImplementation((input) => input.orderId ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ items: [], total: 0 }));
    render(<I18nProvider><OrdersPage /></I18nProvider>);
    await user.click(await screen.findByText('SW-1001'));
    expect(screen.getByRole('button', { name: '申請整單退款' })).toBeDisabled();
    release({ items: [], total: 0 });
    await waitFor(() => expect(screen.getByRole('button', { name: '申請整單退款' })).toBeEnabled());
    vi.mocked(api.listRefunds).mockImplementation((input) => input.orderId ? Promise.reject(new Error('退款讀取失敗')) : Promise.resolve({ items: [], total: 0 }));
    await user.click(screen.getByText('收合'));
    await user.click(screen.getByText('SW-1001'));
    await screen.findByText(/退款讀取失敗/);
    expect(screen.getByRole('button', { name: '申請整單退款' })).toBeDisabled();
  });

  it('確認退款後等待重新讀取期間不送出第二筆', async () => {
    const user = userEvent.setup();
    let expandedReads = 0;
    let release!: (value: { items: Refund[]; total: number }) => void;
    const requestedRefund: Refund = { id: 'active-refund', orderId: order.id, amountCents: order.totalCents, currency: 'TWD', status: 'requested', reason: '重複扣款', failureMessage: null, requestedAt: order.placedAt, completedAt: null };
    vi.mocked(api.listOrders).mockResolvedValue({ items: [{ ...order, status: 'paid' as const }], total: 1 });
    vi.mocked(api.listRefunds).mockImplementation((input) => {
      if (!input.orderId) return Promise.resolve({ items: [], total: 0 });
      expandedReads += 1;
      return expandedReads === 1 ? Promise.resolve({ items: [], total: 0 }) : new Promise((resolve) => { release = resolve; });
    });
    vi.mocked(api.requestRefund).mockResolvedValue(requestedRefund);
    render(<I18nProvider><OrdersPage /></I18nProvider>);
    await user.click(await screen.findByText('SW-1001'));
    await user.type(screen.getByPlaceholderText('退款原因'), '重複扣款');
    await user.click(screen.getByRole('button', { name: '申請整單退款' }));
    await waitFor(() => expect(expandedReads).toBeGreaterThan(1));
    const submit = screen.getByRole('button', { name: '申請整單退款' });
    expect(submit).toBeDisabled();
    release({ items: [requestedRefund], total: 1 });
    expect(await screen.findByText(requestedRefund.reason)).toBeInTheDocument();
    expect(screen.getByText('已申請')).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(api.requestRefund).toHaveBeenCalledTimes(1);
  });

  it('退款終態拒絕與未知後終態重試都保留草稿並換新鑰匙', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listOrders).mockResolvedValue({ items: [{ ...order, status: 'paid' as const }], total: 1 });
    vi.mocked(api.requestRefund).mockRejectedValueOnce(new ApiError('VALIDATION_ERROR', '拒絕', 422)).mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new ApiError('VALIDATION_ERROR', '重試拒絕', 422));
    render(<I18nProvider><OrdersPage /></I18nProvider>);
    await user.click(await screen.findByText('SW-1001'));
    const reason = screen.getByPlaceholderText('退款原因');
    await user.type(reason, '  原始理由  ');
    await user.click(screen.getByRole('button', { name: '申請整單退款' }));
    await screen.findByText('拒絕');
    expect(reason).toHaveValue('  原始理由  ');
    expect(reason).toBeEnabled();
    const first = vi.mocked(api.requestRefund).mock.calls[0];
    await user.click(screen.getByRole('button', { name: '申請整單退款' }));
    await screen.findByText(/timeout/);
    const second = vi.mocked(api.requestRefund).mock.calls[1];
    await user.click(screen.getByRole('button', { name: '以原操作重試' }));
    await screen.findByText('重試拒絕');
    const third = vi.mocked(api.requestRefund).mock.calls[2];
    expect(reason).toHaveValue('  原始理由  ');
    expect(reason).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '申請整單退款' }));
    await waitFor(() => expect(api.requestRefund).toHaveBeenCalledTimes(4));
    const fourth = vi.mocked(api.requestRefund).mock.calls[3];
    expect(second[2]).not.toBe(first[2]);
    expect(third[2]).toBe(second[2]);
    expect(fourth[2]).not.toBe(third[2]);
    expect([first, second, third, fourth].map((call) => call[1])).toEqual(['原始理由', '原始理由', '原始理由', '原始理由']);
  });

  it('shipping 建單佔用 order scope 時不允許訂單付款', async () => {
    const store = createAdminOperationStore();
    store.begin({ area: 'shipping', scope: `order:${order.id}`, idempotencyKey: 'shipping-key' });
    render(<I18nProvider><OrdersPage /></I18nProvider>, store);
    await userEvent.setup().click(await screen.findByText('SW-1001'));
    expect(screen.getByRole('button', { name: '要求付款' })).toBeDisabled();
  });

  it('整單退款在 timeout 後鎖住相同原因與冪等鍵，pending 連點不會多送 command', async () => {
    const user = userEvent.setup();
    const paidOrder = { ...order, status: 'paid' as const };
    vi.mocked(api.listOrders).mockResolvedValue({ items: [paidOrder], total: 1 });
    let reject!: (reason?: unknown) => void;
    vi.mocked(api.requestRefund).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }) as never).mockResolvedValueOnce({ id: 'refund-1' } as never);
    const store = createAdminOperationStore();
    const view = render(<I18nProvider><OrdersPage /></I18nProvider>, store);
    await user.click(await screen.findByText('SW-1001'));
    await user.type(screen.getByPlaceholderText('退款原因'), '  重複扣款  ');
    const submit = screen.getByRole('button', { name: '申請整單退款' });
    await user.dblClick(submit);
    expect(api.requestRefund).toHaveBeenCalledTimes(1);
    reject(new Error('timeout'));
    await screen.findByText(/timeout/);

    const reason = screen.getByPlaceholderText('退款原因');
    expect(reason).toBeDisabled();
    expect(reason).toHaveValue('  重複扣款  ');
    await user.type(reason, '改成其他原因');
    expect(reason).toHaveValue('  重複扣款  ');

    view.unmount();
    render(<I18nProvider><OrdersPage /></I18nProvider>, store);
    expect(await screen.findByText((_, element) => element?.tagName === 'DD' && element.textContent === '  重複扣款  ')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '以原操作重試' }));
    await waitFor(() => expect(api.requestRefund).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(api.requestRefund).mock.calls;
    expect(first[1]).toBe(second[1]);
    expect(first[2]).toBe(second[2]);
  });

  it.each([
    ['zh-TW', '等待付款'],
    ['en-US', 'Awaiting payment'],
    ['ja-JP', '支払い待ち'],
  ])('以 %s 顯示 JSON 日期與 awaiting_payment', async (locale, label) => {
    localStorage.setItem('storeweave.admin.locale', locale);
    const awaitingPaymentOrder: Order = {
      ...order,
      status: 'awaiting_payment',
      adjustments: [{ source: 'reward', sourceId: 'reward-1', name: '購物金折抵', amountCents: -10_000 }],
      placedAt: '2026-08-23T00:00:00.000Z',
    };
    vi.mocked(api.listOrders).mockResolvedValue({ items: [awaitingPaymentOrder], total: 1 });
    render(<I18nProvider><OrdersPage /></I18nProvider>);

    const orderRow = (await screen.findByText('SW-1001')).closest('tr')!;
    expect(within(orderRow).getByText(label)).toBeInTheDocument();
    expect(within(orderRow).getByText(new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(awaitingPaymentOrder.placedAt)))).toBeInTheDocument();
  });

  it('顯示等待付款的購物金折抵，將它算進待處理並可篩選', async () => {
    const awaitingPaymentOrder: Order = {
      ...order,
      id: '77777777-7777-4777-8777-777777777777',
      number: 'SW-1002',
      status: 'awaiting_payment',
      adjustments: [{ source: 'reward', sourceId: 'reward-1', name: '購物金折抵', amountCents: -10_000 }],
      placedAt: '2026-08-23T00:00:00.000Z',
      expiresAt: '2026-08-24T00:00:00.000Z',
    };
    vi.mocked(api.listOrders).mockResolvedValue({ items: [awaitingPaymentOrder], total: 1 });
    const user = userEvent.setup();
    render(<I18nProvider><OrdersPage /></I18nProvider>);

    const orderRow = (await screen.findByText('SW-1002')).closest('tr')!;
    expect(within(orderRow).getByText('等待付款')).toBeInTheDocument();
    expect(screen.getByText('待處理訂單').parentElement).toHaveTextContent('1');

    await user.click(screen.getByText('SW-1002'));
    expect(screen.getByText('購物金折抵')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '要求付款' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消訂單' })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox'), 'awaiting_payment');
    await waitFor(() => expect(api.listOrders).toHaveBeenLastCalledWith({ status: 'awaiting_payment', limit: 50, offset: 0 }, expect.any(AbortSignal)));
  });

  it('顯示全域退款隊列與安全重試入口', async () => {
    vi.mocked(api.listRefunds).mockResolvedValue({
      items: [{ id: 'refund-1', orderId: order.id, amountCents: 140_000, currency: 'TWD', status: 'failed', reason: 'internal', failureMessage: 'provider declined', requestedAt: order.placedAt, completedAt: order.placedAt }], total: 1,
    });
    render(<I18nProvider><OrdersPage /></I18nProvider>);
    expect(await screen.findByText('退款作業隊列')).toBeInTheDocument();
    expect(await screen.findByText('provider declined')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重試退款' })).toBeInTheDocument();
  });

  it('顯示退貨案件隊列與核准入口', async () => {
    vi.mocked(api.listRmas).mockResolvedValue({
      items: [{ id: 'rma-1', orderId: order.id, customerId: 'customer-1', status: 'requested', resolution: 'refund_and_reorder', reason: '瑕疵', staffNote: null, refundId: null, receivedAt: null, completedAt: null, createdAt: order.placedAt, updatedAt: order.placedAt, lines: [{ id: 'rma-line-1', orderLineId: order.lines[0].id, productId: order.lines[0].productId, sku: 'TEA-001', name: '高山烏龍', quantity: 1, unitPriceCents: 50_000, lineTotalCents: 50_000, discountCents: 0, disposition: null, discardReason: null }] }], total: 1,
    });
    render(<I18nProvider><OrdersPage /></I18nProvider>);
    expect(await screen.findByText('退貨作業隊列')).toBeInTheDocument();
    expect(await screen.findByText('瑕疵')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '核准' })).toBeInTheDocument();
  });

  it('展開後顯示折扣明細與分攤後的行金額', async () => {
    const user = userEvent.setup();
    render(<I18nProvider><OrdersPage /></I18nProvider>);

    await user.click(await screen.findByText('SW-1001'));

    // 行層：牌價 1500、折 100、實收 1400
    const lineRow = screen.getByText('TEA-001').closest('tr')!;
    expect(lineRow).toHaveTextContent('-$100.00');
    expect(lineRow).toHaveTextContent('$1,400.00');

    // 訂單層：小計、套用的活動、總計
    const totals = document.querySelector('.order-totals')!;
    expect(totals).toHaveTextContent('滿千折百');
    expect(totals).toHaveTextContent('-$100.00');
    expect(totals).toHaveTextContent('$1,500.00');
    expect(totals).toHaveTextContent('$1,400.00');
  });

  it('沒有折扣的訂單不顯示任何活動', async () => {
    vi.mocked(api.listOrders).mockResolvedValue({
      items: [{ ...order, discountCents: 0, totalCents: 150_000, adjustments: [], lines: [{ ...order.lines[0], discountCents: 0 }] }],
      total: 1,
    });
    const user = userEvent.setup();
    render(<I18nProvider><OrdersPage /></I18nProvider>);

    await user.click(await screen.findByText('SW-1001'));

    expect(screen.queryByText('滿千折百')).not.toBeInTheDocument();
    const lineRow = screen.getByText('TEA-001').closest('tr')!;
    expect(lineRow).toHaveTextContent('—');
  });
});
