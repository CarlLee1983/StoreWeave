import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrdersPage } from './OrdersPage';
import { I18nProvider } from '../i18n';
import { api, type Order } from '../api';

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
  placedAt: '2026-08-22T00:00:00.000Z',
  paidAt: null,
  cancelledAt: null,
  expiresAt: null,
};

beforeEach(() => {
  vi.mocked(api.listOrders).mockReset().mockResolvedValue({ items: [order], total: 1 });
  vi.mocked(api.listRefunds).mockReset().mockResolvedValue({ items: [], total: 0 });
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

    await waitFor(() => expect(api.rejectRma).toHaveBeenCalledWith('rma-1', '不符合退貨條件'));
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
  it('顯示全域退款隊列與安全重試入口', async () => {
    vi.mocked(api.listRefunds).mockResolvedValue({
      items: [{ id: 'refund-1', orderId: order.id, amountCents: 140_000, currency: 'TWD', status: 'failed', reason: 'internal', failureMessage: 'provider declined', requestedAt: order.placedAt, completedAt: order.placedAt }], total: 1,
    });
    render(<I18nProvider><OrdersPage /></I18nProvider>);
    expect(await screen.findByText('退款作業隊列')).toBeInTheDocument();
    expect(screen.getByText('provider declined')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重試退款' })).toBeInTheDocument();
  });

  it('顯示退貨案件隊列與核准入口', async () => {
    vi.mocked(api.listRmas).mockResolvedValue({
      items: [{ id: 'rma-1', orderId: order.id, customerId: 'customer-1', status: 'requested', resolution: 'refund_and_reorder', reason: '瑕疵', staffNote: null, refundId: null, receivedAt: null, completedAt: null, createdAt: order.placedAt, updatedAt: order.placedAt, lines: [{ id: 'rma-line-1', orderLineId: order.lines[0].id, productId: order.lines[0].productId, sku: 'TEA-001', name: '高山烏龍', quantity: 1, unitPriceCents: 50_000, lineTotalCents: 50_000, discountCents: 0, disposition: null, discardReason: null }] }], total: 1,
    });
    render(<I18nProvider><OrdersPage /></I18nProvider>);
    expect(await screen.findByText('退貨作業隊列')).toBeInTheDocument();
    expect(screen.getByText('瑕疵')).toBeInTheDocument();
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
