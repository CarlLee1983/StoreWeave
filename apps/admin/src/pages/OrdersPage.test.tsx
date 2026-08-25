import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
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
