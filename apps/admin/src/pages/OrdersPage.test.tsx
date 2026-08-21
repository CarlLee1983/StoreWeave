import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrdersPage } from './OrdersPage';
import { I18nProvider } from '../i18n';
import { api, type Order } from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { listOrders: vi.fn(), payOrder: vi.fn(), cancelOrder: vi.fn() } };
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
});

describe('OrdersPage', () => {
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
