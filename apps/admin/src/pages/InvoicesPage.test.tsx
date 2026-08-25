import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InvoicesPage } from './InvoicesPage';
import { I18nProvider } from '../i18n';
import { api, type Invoice } from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { listInvoices: vi.fn(), retryInvoiceIssue: vi.fn(), retryInvoiceVoid: vi.fn() } };
});

const issued: Invoice = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', orderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', orderNumber: 'SW-2001',
  provider: 'ecpay-invoice', reference: 'invoice:aaaa', currency: 'TWD', amountCents: 130000, taxCents: 6190,
  carrier: { kind: 'mobile', number: '/ABC1234' }, status: 'issued', providerRef: 'ec_1', invoiceNumber: 'AB12345678',
  invoiceDate: '2026-08-25 09:00:00', issueAttempts: 1, voidAttempts: 0, lastError: null,
  issuedAt: '2026-08-25T01:00:00.000Z', voidedAt: null, createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T01:00:00.000Z',
};
const failed: Invoice = {
  ...issued, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', orderNumber: 'SW-2002', status: 'issue_failed',
  providerRef: null, invoiceNumber: null, invoiceDate: null, issueAttempts: 3, lastError: 'ECPay rejected the carrier number', issuedAt: null,
};

beforeEach(() => {
  vi.mocked(api.listInvoices).mockReset().mockResolvedValue({ items: [issued, failed], total: 2 });
  vi.mocked(api.retryInvoiceIssue).mockReset().mockResolvedValue({ ...failed, issueAttempts: 4 });
  vi.mocked(api.retryInvoiceVoid).mockReset().mockResolvedValue({ ...issued, status: 'void_pending' });
});

const renderPage = () => render(<I18nProvider><InvoicesPage /></I18nProvider>);

describe('InvoicesPage', () => {
  it('顯示發票號碼、開立日期、嘗試次數與失敗原因', async () => {
    renderPage();
    expect(await screen.findByText('AB12345678')).toBeInTheDocument();
    expect(screen.getByText('2026-08-25 09:00:00')).toBeInTheDocument();
    expect(screen.getByText('ECPay rejected the carrier number')).toBeInTheDocument();
  });

  it('重試只出現在失敗的那一筆上', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('SW-2002');
    const retries = screen.getAllByRole('button', { name: '重送開立' });
    expect(retries).toHaveLength(1);
    await user.click(retries[0]);
    await waitFor(() => expect(api.retryInvoiceIssue).toHaveBeenCalledWith(failed.id));
  });

  it('作廢失敗才給重送作廢，成功開立的不給', async () => {
    vi.mocked(api.listInvoices).mockResolvedValue({ items: [issued, { ...issued, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', orderNumber: 'SW-2003', status: 'void_failed', voidAttempts: 2, lastError: 'ECPay void rejected' }], total: 2 });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('SW-2003');
    const retries = screen.getAllByRole('button', { name: '重送作廢' });
    expect(retries).toHaveLength(1);
    await user.click(retries[0]);
    await waitFor(() => expect(api.retryInvoiceVoid).toHaveBeenCalledWith('dddddddd-dddd-4ddd-8ddd-dddddddddddd'));
  });

  it('卡在 pending 或 void_pending 的也給得出重送，那是唯一的出口', async () => {
    vi.mocked(api.listInvoices).mockResolvedValue({ items: [
      { ...issued, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', orderNumber: 'SW-2004', status: 'pending', invoiceNumber: null, invoiceDate: null, issuedAt: null },
      { ...issued, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', orderNumber: 'SW-2005', status: 'void_pending' },
    ], total: 2 });
    renderPage();
    await screen.findByText('SW-2004');
    expect(screen.getAllByRole('button', { name: '重送開立' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '重送作廢' })).toHaveLength(1);
  });

  it('依狀態篩選會重新查詢', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('SW-2001');
    await user.selectOptions(screen.getByLabelText('發票狀態'), 'issue_failed');
    await waitFor(() => expect(api.listInvoices).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'issue_failed' })));
  });
});
