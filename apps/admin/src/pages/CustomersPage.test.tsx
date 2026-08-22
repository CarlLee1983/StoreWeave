import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CustomersPage } from './CustomersPage';
import { I18nProvider } from '../i18n';
import { api, type AdminCustomer, type AdminCustomerDetail } from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: { listCustomers: vi.fn(), getCustomer: vi.fn(), setCustomerStatus: vi.fn() },
  };
});

const customer: AdminCustomer = {
  id: '77777777-7777-4777-8777-777777777777',
  accountId: '88888888-8888-4888-8888-888888888888',
  email: 'buyer@example.com',
  displayName: '買家',
  birthday: '1990-05-20',
  phone: '0912345678',
  address: null,
  status: 'active',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const detail: AdminCustomerDetail = {
  ...customer,
  orders: [
    { id: '99999999-9999-4999-8999-999999999999', number: 'SW-1001', status: 'paid', currency: 'TWD', totalCents: 140_000, placedAt: '2026-08-20T00:00:00.000Z' },
  ],
};

const renderPage = () => render(<I18nProvider><CustomersPage /></I18nProvider>);

beforeEach(() => {
  vi.mocked(api.listCustomers).mockReset().mockResolvedValue({ items: [customer], total: 1 });
  vi.mocked(api.getCustomer).mockReset().mockResolvedValue(detail);
  vi.mocked(api.setCustomerStatus).mockReset().mockResolvedValue({ ...customer, status: 'disabled' });
});

describe('CustomersPage', () => {
  it('列出會員的 email、顯示名稱與狀態', async () => {
    renderPage();

    const row = (await screen.findByText('buyer@example.com')).closest('tr')!;
    expect(row).toHaveTextContent('買家');
    expect(row).toHaveTextContent('上架中');
  });

  it('搜尋會帶著關鍵字重新查詢', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('buyer@example.com');

    await user.type(screen.getByLabelText('搜尋會員'), 'buyer');

    await waitFor(() => expect(vi.mocked(api.listCustomers).mock.calls.at(-1)![0]).toMatchObject({ q: 'buyer' }));
  });

  it('展開會員看得到個人資料與訂單歷史', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('buyer@example.com'));

    await waitFor(() => expect(api.getCustomer).toHaveBeenCalledWith(customer.id));
    expect(await screen.findByText('SW-1001')).toBeInTheDocument();
    expect(screen.getByText('1990-05-20')).toBeInTheDocument();
  });

  it('停用會員後重新載入清單', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('buyer@example.com');

    await user.click(screen.getByRole('button', { name: '停用' }));

    await waitFor(() => expect(api.setCustomerStatus).toHaveBeenCalledWith(customer.id, 'disabled'));
    expect(api.listCustomers).toHaveBeenCalledTimes(2);
  });

  it('已停用的會員可以重新啟用', async () => {
    vi.mocked(api.listCustomers).mockResolvedValue({ items: [{ ...customer, status: 'disabled' }], total: 1 });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('buyer@example.com');

    await user.click(screen.getByRole('button', { name: '啟用' }));

    await waitFor(() => expect(api.setCustomerStatus).toHaveBeenCalledWith(customer.id, 'active'));
  });

  it('畫面上不出現任何憑證欄位', async () => {
    renderPage();
    await screen.findByText('buyer@example.com');

    expect(document.body.textContent).not.toMatch(/password|hash|scrypt/i);
  });
});
