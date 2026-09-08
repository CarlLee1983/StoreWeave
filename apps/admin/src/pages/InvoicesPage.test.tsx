import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { InvoicesPage } from './InvoicesPage';
import { I18nProvider } from '../i18n';
import { ApiError, api, type Invoice } from '../api';
import { createAdminQueryClient, deadJobKeys, healthKeys, invoiceKeys } from '../query';
import { AdminOperationProvider, createAdminOperationStore } from '../admin-operations';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { listInvoices: vi.fn(), retryInvoiceIssue: vi.fn(), retryInvoiceVoid: vi.fn() } };
});

const issued: Invoice = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', orderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', orderNumber: 'SW-2001', provider: 'ecpay-invoice', reference: 'invoice:aaaa', currency: 'TWD', amountCents: 130000, taxCents: 6190, carrier: { kind: 'mobile', number: '/ABC1234' }, status: 'issued', providerRef: 'ec_1', invoiceNumber: 'AB12345678', invoiceDate: '2026-08-25 09:00:00', issueAttempts: 1, voidAttempts: 0, lastError: null, issuedAt: '2026-08-25T01:00:00.000Z', voidedAt: null, createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T01:00:00.000Z' };
const failed: Invoice = { ...issued, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', orderNumber: 'SW-2002', status: 'issue_failed', providerRef: null, invoiceNumber: null, invoiceDate: null, issueAttempts: 3, lastError: 'ECPay rejected the carrier number', issuedAt: null };
const voidFailed: Invoice = { ...issued, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', orderNumber: 'SW-2003', status: 'void_failed', voidAttempts: 2, lastError: 'void failed' };
const renderPage = (client = createAdminQueryClient(), store = createAdminOperationStore()) => render(<QueryClientProvider client={client}><AdminOperationProvider value={store}><I18nProvider><InvoicesPage /></I18nProvider></AdminOperationProvider></QueryClientProvider>);

beforeEach(() => {
  vi.mocked(api.listInvoices).mockReset().mockResolvedValue({ items: [issued, failed], total: 2 });
  vi.mocked(api.retryInvoiceIssue).mockReset().mockResolvedValue({ ...failed, issueAttempts: 4 });
  vi.mocked(api.retryInvoiceVoid).mockReset().mockResolvedValue({ ...issued, status: 'void_pending' });
});

describe('InvoicesPage', () => {
  it('保留發票號碼、失敗原因與只有對應狀態才顯示重送的行為', async () => {
    renderPage();
    expect(await screen.findByText('AB12345678')).toBeInTheDocument();
    expect(screen.getByText('2026-08-25 09:00:00')).toBeInTheDocument();
    expect(screen.getByText('ECPay rejected the carrier number')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '重送開立' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '重送作廢' })).not.toBeInTheDocument();
  });

  it('pending 與 void_pending 保留原本唯一的重送出口', async () => {
    vi.mocked(api.listInvoices).mockResolvedValue({ items: [
      { ...issued, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', status: 'pending', invoiceNumber: null, invoiceDate: null, issuedAt: null },
      { ...issued, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', status: 'void_pending' },
    ], total: 2 });
    renderPage();
    expect(await screen.findByRole('button', { name: '重送開立' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '重送作廢' })).toBeEnabled();
  });

  it('以 status、limit、offset 與 signal 查詢發票', async () => {
    renderPage();
    expect(await screen.findByText('AB12345678')).toBeInTheDocument();
    expect(api.listInvoices).toHaveBeenCalledWith({ limit: 50, offset: 0 }, expect.any(AbortSignal));
    await userEvent.setup().selectOptions(screen.getByLabelText('發票狀態'), 'issue_failed');
    await waitFor(() => expect(api.listInvoices).toHaveBeenLastCalledWith({ status: 'issue_failed', limit: 50, offset: 0 }, expect.any(AbortSignal)));
  });

  it('issue 與 void 各自使用正確 command，且各自確認後失效 invoice detail、DLQ、health', async () => {
    const client = createAdminQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const user = userEvent.setup();
    renderPage(client);
    await user.click(await screen.findByRole('button', { name: '重送開立' }));
    await waitFor(() => expect(api.retryInvoiceIssue).toHaveBeenCalledWith(failed.id, expect.any(String)));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: invoiceKeys.lists });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: invoiceKeys.detail(failed.id) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: deadJobKeys.lists });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: healthKeys.dependencies });
    expect(invalidate).toHaveBeenCalledTimes(4);
    invalidate.mockClear();

    vi.mocked(api.listInvoices).mockResolvedValue({ items: [voidFailed], total: 1 });
    await user.selectOptions(screen.getByLabelText('發票狀態'), 'void_failed');
    await user.click(await screen.findByRole('button', { name: '重送作廢' }));
    await waitFor(() => expect(api.retryInvoiceVoid).toHaveBeenCalledWith(voidFailed.id, expect.any(String)));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(4));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: invoiceKeys.lists });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: invoiceKeys.detail(voidFailed.id) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: deadJobKeys.lists });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: healthKeys.dependencies });
  });

  it('unknown retry keeps the issue key; a terminal rejection unlocks a new issue command', async () => {
    const user = userEvent.setup();
    vi.mocked(api.retryInvoiceIssue).mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new ApiError('VALIDATION_ERROR', 'rejected', 422)).mockResolvedValueOnce(failed);
    renderPage();
    await user.click(await screen.findByRole('button', { name: '重送開立' }));
    await user.click(await screen.findByRole('button', { name: '以原操作重試' }));
    expect(await screen.findByText('rejected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重送開立' }));
    await waitFor(() => expect(api.retryInvoiceIssue).toHaveBeenCalledTimes(3));
    const keys = vi.mocked(api.retryInvoiceIssue).mock.calls.map((call) => call[1]);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('a void recovery occupies the same invoice scope as issue', async () => {
    const store = createAdminOperationStore();
    store.begin({ area: 'invoice', scope: `invoice:${failed.id}`, kind: 'retry-void', invoiceId: failed.id, idempotencyKey: 'void-key' });
    renderPage(createAdminQueryClient(), store);
    expect(await screen.findByRole('button', { name: '重送開立' })).toBeDisabled();
  });

  it('invoice issue held-pending retry suppresses a second concrete click', async () => {
    let release!: (result: Invoice) => void;
    vi.mocked(api.retryInvoiceIssue).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const user = userEvent.setup();
    renderPage();
    const retry = await screen.findByRole('button', { name: '重送開立' });
    await user.dblClick(retry);
    expect(api.retryInvoiceIssue).toHaveBeenCalledTimes(1);
    release(failed);
  });

  it('invoice void held-pending retry suppresses a second concrete click', async () => {
    let release!: (result: Invoice) => void;
    vi.mocked(api.listInvoices).mockResolvedValue({ items: [voidFailed], total: 1 });
    vi.mocked(api.retryInvoiceVoid).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const user = userEvent.setup();
    renderPage();
    const retry = await screen.findByRole('button', { name: '重送作廢' });
    await user.dblClick(retry);
    expect(api.retryInvoiceVoid).toHaveBeenCalledTimes(1);
    release(voidFailed);
  });

  it('issue recovery remains retryable and cannot be reinterpreted as a void command', async () => {
    const store = createAdminOperationStore();
    const handle = store.begin({ area: 'invoice', scope: `invoice:${failed.id}`, kind: 'retry-issue', invoiceId: failed.id, idempotencyKey: 'issue-recovery-key' })!;
    store.markUnknown(handle, new Error('timeout'));
    vi.mocked(api.listInvoices).mockResolvedValue({ items: [{ ...voidFailed, id: failed.id }], total: 1 });
    renderPage(createAdminQueryClient(), store);
    expect(await screen.findByRole('button', { name: '重送作廢' })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole('button', { name: '以原操作重試' }));
    await waitFor(() => expect(api.retryInvoiceIssue).toHaveBeenCalledWith(failed.id, 'issue-recovery-key'));
    expect(api.retryInvoiceVoid).not.toHaveBeenCalled();
  });

  it('void recovery remains retryable and cannot be reinterpreted as an issue command', async () => {
    const store = createAdminOperationStore();
    const handle = store.begin({ area: 'invoice', scope: `invoice:${failed.id}`, kind: 'retry-void', invoiceId: failed.id, idempotencyKey: 'void-recovery-key' })!;
    store.markUnknown(handle, new Error('timeout'));
    renderPage(createAdminQueryClient(), store);
    expect(await screen.findByRole('button', { name: '重送開立' })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole('button', { name: '以原操作重試' }));
    await waitFor(() => expect(api.retryInvoiceVoid).toHaveBeenCalledWith(failed.id, 'void-recovery-key'));
    expect(api.retryInvoiceIssue).not.toHaveBeenCalled();
  });

  it('空結果仍顯示既有空狀態', async () => {
    vi.mocked(api.listInvoices).mockResolvedValue({ items: [], total: 0 });
    renderPage();
    expect(await screen.findByText('這個狀態下目前沒有發票紀錄。')).toBeInTheDocument();
  });
});
