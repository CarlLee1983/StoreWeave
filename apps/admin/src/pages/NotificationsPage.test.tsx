import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationsPage } from './NotificationsPage';
import { I18nProvider } from '../i18n';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAdminQueryClient } from '../query';
import { api, type LifecycleDelivery } from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { listLifecycleDeliveries: vi.fn() } };
});

const sent: LifecycleDelivery = {
  id: '11111111-1111-4111-8111-111111111111', eventId: '22222222-2222-4222-8222-222222222222',
  orderId: '33333333-3333-4333-8333-333333333333', template: 'customer.order-paid',
  reference: 'notify:1', recipientMasked: 'a****@example.com', status: 'sent', providerRef: 'mock-1',
  attempts: 1, lastError: null, sentAt: '2026-08-25T01:00:00.000Z',
  createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T01:00:00.000Z',
};
const failed: LifecycleDelivery = {
  ...sent, id: '44444444-4444-4444-8444-444444444444', template: 'customer.shipment-shipped',
  status: 'failed', providerRef: null, attempts: 3, lastError: 'SMTP 550 mailbox unavailable', sentAt: null,
};

beforeEach(() => {
  vi.mocked(api.listLifecycleDeliveries).mockReset().mockResolvedValue({ items: [sent, failed], total: 2 });
});

const renderPage = () => render(<QueryClientProvider client={createAdminQueryClient()}><I18nProvider><NotificationsPage /></I18nProvider></QueryClientProvider>);

describe('NotificationsPage（工單 73）', () => {
  it('顯示事件、狀態、嘗試次數與失敗原因', async () => {
    renderPage();
    expect(await screen.findByText('customer.order-paid')).toBeInTheDocument();
    expect(screen.getByText('SMTP 550 mailbox unavailable')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('收件人只顯示遮蔽值，頁面上不出現完整地址', async () => {
    const { container } = renderPage();
    expect(await screen.findAllByText('a****@example.com')).toHaveLength(2);
    expect(container.textContent).not.toMatch(/[^*]@example\.com/);
  });

  it('可依狀態與訂單重新查詢', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('customer.order-paid');
    await user.selectOptions(screen.getByLabelText('投遞狀態'), 'failed');
    await waitFor(() => expect(api.listLifecycleDeliveries).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed' }), expect.anything()));

    await user.type(screen.getByLabelText('訂單 ID'), sent.orderId);
    await user.click(screen.getByRole('button', { name: '查詢' }));
    await waitFor(() => expect(api.listLifecycleDeliveries).toHaveBeenLastCalledWith(expect.objectContaining({ orderId: sent.orderId }), expect.anything()));
  });

  it('說明這裡不提供手動重送，以及為什麼', async () => {
    renderPage();
    expect(await screen.findByText(/不提供手動重送/)).toBeInTheDocument();
  });

  it('沒有通知時顯示空狀態', async () => {
    vi.mocked(api.listLifecycleDeliveries).mockResolvedValue({ items: [], total: 0 });
    renderPage();

    expect(await screen.findByText('這個條件下沒有通知紀錄。')).toBeInTheDocument();
  });

  it('讀取失敗時提供重試且不把失敗畫成空清單', async () => {
    vi.mocked(api.listLifecycleDeliveries).mockRejectedValueOnce(new Error('delivery read failed')).mockResolvedValueOnce({ items: [sent], total: 1 });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('delivery read failed')).toBeInTheDocument();
    expect(screen.queryByText('這個條件下沒有通知紀錄。')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新讀取' }));
    expect(await screen.findByText('customer.order-paid')).toBeInTheDocument();
    expect(api.listLifecycleDeliveries).toHaveBeenCalledTimes(2);
  });
});
