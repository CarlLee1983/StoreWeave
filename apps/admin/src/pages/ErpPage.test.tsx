import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { ErpPage } from './ErpPage';
import { I18nProvider } from '../i18n';
import { ApiError, api, type Delivery } from '../api';
import { createAdminQueryClient, deadJobKeys, erpDeliveryKeys, healthKeys } from '../query';
import { AdminOperationProvider, createAdminOperationStore } from '../admin-operations';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { listDeliveries: vi.fn(), inspectDeliveryPayload: vi.fn(), resendOrder: vi.fn() } };
});

const delivery: Delivery = { orderId: 'order-1', orderNumber: 'SW-3001', reference: 'erp:order-1', status: 'failed', attempts: 3, manualResends: 1, lastError: 'timeout', remoteId: null, jobId: 'job-1', firstSeenAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z' };
const renderPage = (client = createAdminQueryClient(), store = createAdminOperationStore()) => render(<QueryClientProvider client={client}><AdminOperationProvider value={store}><I18nProvider><ErpPage /></I18nProvider></AdminOperationProvider></QueryClientProvider>);

beforeEach(() => {
  localStorage.setItem('storeweave.admin.locale', 'zh-TW');
  vi.mocked(api.listDeliveries).mockReset().mockResolvedValue({ items: [delivery] });
  vi.mocked(api.inspectDeliveryPayload).mockReset().mockResolvedValue({ orderId: delivery.orderId, payload: { orderNumber: delivery.orderNumber } });
  vi.mocked(api.resendOrder).mockReset().mockResolvedValue({ orderId: delivery.orderId, status: 'pending', attempts: 1, jobId: 'job-2' });
});

describe('ErpPage', () => {
  it('reads list and payload independently with their exact signal inputs', async () => {
    const user = userEvent.setup();
    renderPage();
    const payload = await screen.findByRole('button', { name: 'Payload' });
    expect(api.listDeliveries).toHaveBeenCalledWith(50, expect.any(AbortSignal));
    await user.click(payload);
    expect(await screen.findByRole('dialog', { name: /ERP payload/ })).toHaveTextContent('SW-3001');
    expect(api.inspectDeliveryPayload).toHaveBeenCalledWith(delivery.orderId, expect.any(AbortSignal));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(payload).toHaveFocus();
  });

  it.each([['zh-TW', '操作'], ['en-US', 'Actions'], ['ja-JP', '操作']])('keeps action-header scope in %s', async (locale, label) => {
    localStorage.setItem('storeweave.admin.locale', locale);
    renderPage();
    expect(await screen.findByRole('columnheader', { name: label })).toHaveAttribute('scope', 'col');
  });

  it('keeps the existing empty state', async () => {
    vi.mocked(api.listDeliveries).mockResolvedValue({ items: [] });
    renderPage();
    expect(await screen.findByText('目前沒有 ERP 投遞紀錄。')).toBeInTheDocument();
  });

  it('resend invalidates ERP, DLQ, and health but not payload detail', async () => {
    const client = createAdminQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    renderPage(client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /更多操作/ }));
    await user.click(await screen.findByRole('menuitem', { name: '重送' }));
    await waitFor(() => expect(api.resendOrder).toHaveBeenCalledWith(delivery.orderId, expect.any(String)));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: erpDeliveryKeys.lists });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: deadJobKeys.lists });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: healthKeys.dependencies });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: erpDeliveryKeys.detail(delivery.orderId) });
  });

  it('keeps a repeated-unknown terminal rejection visibly inside the active payload dialog', async () => {
    const user = userEvent.setup();
    vi.mocked(api.resendOrder).mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new Error('still timeout')).mockRejectedValueOnce(new ApiError('VALIDATION_ERROR', 'terminal ERP rejection', 422));
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Payload' }));
    const dialog = await screen.findByRole('dialog', { name: /ERP payload/ });
    await user.click(within(dialog).getByRole('button', { name: '重送至 ERP' }));
    const retry = await within(dialog).findByRole('button', { name: '以原操作重試' });
    expect(retry).toHaveFocus();
    const firstKey = vi.mocked(api.resendOrder).mock.calls[0][1];
    await user.click(retry);
    const repeatedRetry = await within(dialog).findByRole('button', { name: '以原操作重試' });
    expect(repeatedRetry).toHaveFocus();
    await user.click(repeatedRetry);
    expect(await within(dialog).findByText('terminal ERP rejection')).toBeInTheDocument();
    expect(vi.mocked(api.resendOrder).mock.calls.map((call) => call[1])).toEqual([firstKey, firstKey, firstKey]);
  });

  it('a payload read failure does not disable resend', async () => {
    vi.mocked(api.inspectDeliveryPayload).mockRejectedValue(new Error('payload unavailable'));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Payload' }));
    expect(await screen.findByText('payload unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重送至 ERP' })).toBeEnabled();
  });

  it('ERP drawer held-pending resend suppresses a second concrete click', async () => {
    let release!: (result: { orderId: string; status: string; attempts: number; jobId: string }) => void;
    vi.mocked(api.resendOrder).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Payload' }));
    const resend = await screen.findByRole('button', { name: '重送至 ERP' });
    await user.dblClick(resend);
    expect(api.resendOrder).toHaveBeenCalledTimes(1);
    release({ orderId: delivery.orderId, status: 'pending', attempts: 1, jobId: 'job-2' });
  });

  it('ERP row resend occupies the same scope in the payload drawer', async () => {
    let release!: (result: { orderId: string; status: string; attempts: number; jobId: string }) => void;
    vi.mocked(api.resendOrder).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /更多操作/ }));
    await user.click(await screen.findByRole('menuitem', { name: '重送' }));
    await waitFor(() => expect(api.resendOrder).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Payload' }));
    expect(await screen.findByRole('button', { name: '重送中…' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '重送中…' }));
    expect(api.resendOrder).toHaveBeenCalledTimes(1);
    release({ orderId: delivery.orderId, status: 'pending', attempts: 1, jobId: 'job-2' });
  });

  it('ERP drawer resend occupies the same scope back in the row after closing', async () => {
    let release!: (result: { orderId: string; status: string; attempts: number; jobId: string }) => void;
    vi.mocked(api.resendOrder).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Payload' }));
    await user.click(await screen.findByRole('button', { name: '重送至 ERP' }));
    await waitFor(() => expect(api.resendOrder).toHaveBeenCalledTimes(1));
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('button', { name: /更多操作/ })).toBeDisabled();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(api.resendOrder).toHaveBeenCalledTimes(1);
    release({ orderId: delivery.orderId, status: 'pending', attempts: 1, jobId: 'job-2' });
  });
});
