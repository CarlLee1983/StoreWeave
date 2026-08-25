import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CustomersPage } from './CustomersPage';
import { I18nProvider } from '../i18n';
import { api, type AdminCustomer, type AdminCustomerDetail, type CustomerLoyalty } from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      listCustomers: vi.fn(), getCustomer: vi.fn(), setCustomerStatus: vi.fn(),
      customerLoyalty: vi.fn(), adjustRewards: vi.fn(), adjustTierPoints: vi.fn(), correctCustomerBirthday: vi.fn(),
    },
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

const loyalty: CustomerLoyalty = {
  currency: 'TWD',
  balance: { availableCents: 12_000, pendingCents: 3_000, expiredCents: 0, nextExpiry: null },
  tierName: '銀卡',
  tierPoints: 4_200,
  entries: [],
};

const renderPage = () => render(<I18nProvider><CustomersPage /></I18nProvider>);

beforeEach(() => {
  vi.mocked(api.listCustomers).mockReset().mockResolvedValue({ items: [customer], total: 1 });
  vi.mocked(api.correctCustomerBirthday).mockReset().mockResolvedValue({ ...customer, birthday: '1990-02-03' });
  vi.mocked(api.getCustomer).mockReset().mockResolvedValue(detail);
  vi.mocked(api.setCustomerStatus).mockReset().mockResolvedValue({ ...customer, status: 'disabled' });
  vi.mocked(api.customerLoyalty).mockReset().mockResolvedValue(loyalty);
  vi.mocked(api.adjustRewards).mockReset().mockResolvedValue({ id: 'entry-1' });
  vi.mocked(api.adjustTierPoints).mockReset().mockResolvedValue({ points: 4_300 });
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

describe('客服補償（工單 46）', () => {
  it('展開後看得到目前的購物金與等級', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText('buyer@example.com'));

    expect(await screen.findByText('銀卡（4200）')).toBeInTheDocument();
    expect(screen.getByText('可用購物金')).toBeInTheDocument();
  });

  it('調整購物金要帶原因，送出後重新讀取餘額', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText('buyer@example.com'));
    await screen.findByText('銀卡（4200）');

    await user.type(screen.getByLabelText('調整購物金'), '5000');
    await user.type(screen.getAllByLabelText('原因')[0], '客訴補償');
    await user.click(screen.getAllByRole('button', { name: '調整' })[0]);

    await waitFor(() => expect(api.adjustRewards).toHaveBeenCalledWith(
      customer.id, { amountCents: 5_000, reason: '客訴補償' }, expect.any(String),
    ));
    await waitFor(() => expect(api.customerLoyalty).toHaveBeenCalledTimes(2));
  });

  it('等級積分是另一個表單——兩本帳不共用一個輸入框', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText('buyer@example.com'));
    await screen.findByText('銀卡（4200）');

    await user.type(screen.getByLabelText('調整等級積分'), '-100');
    await user.type(screen.getAllByLabelText('原因')[1], '重複計算，收回');
    await user.click(screen.getAllByRole('button', { name: '調整' })[1]);

    await waitFor(() => expect(api.adjustTierPoints).toHaveBeenCalledWith(
      customer.id, { points: -100, reason: '重複計算，收回' }, expect.any(String),
    ));
    expect(api.adjustRewards).not.toHaveBeenCalled();
  });

  it('沒填原因就不送出：沒有原因的調整事後查不到帳', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText('buyer@example.com'));
    await screen.findByText('銀卡（4200）');

    await user.type(screen.getByLabelText('調整購物金'), '5000');
    await user.click(screen.getAllByRole('button', { name: '調整' })[0]);

    expect(await screen.findByText('請輸入非零整數與調整原因')).toBeInTheDocument();
    expect(api.adjustRewards).not.toHaveBeenCalled();
  });
});

describe('調帳的冪等（審查發現）', () => {
  it('同一份表單重送用的是同一把鑰匙——連點兩下不會補兩次', async () => {
    const user = userEvent.setup();
    // 第一次讓它失敗，表單留在原地，使用者再按一次。
    vi.mocked(api.adjustRewards).mockRejectedValueOnce(new Error('timeout'));
    renderPage();
    await user.click(await screen.findByText('buyer@example.com'));
    await screen.findByText('銀卡（4200）');

    await user.type(screen.getByLabelText('調整購物金'), '5000');
    await user.type(screen.getAllByLabelText('原因')[0], '補償');
    await user.click(screen.getAllByRole('button', { name: '調整' })[0]);
    await screen.findByText(/timeout/);
    await user.click(screen.getAllByRole('button', { name: '調整' })[0]);

    await waitFor(() => expect(api.adjustRewards).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(api.adjustRewards).mock.calls;
    expect(second[2]).toBe(first[2]);
  });
});

describe('客服修正生日（工單 74）', () => {
  it('沒填原因就不送出：沒有理由的更正事後查不到帳', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText('buyer@example.com'));
    await user.click(await screen.findByRole('button', { name: '修正生日' }));
    await user.type(screen.getByLabelText('更正後的生日'), '1990-02-03');
    await user.click(screen.getByRole('button', { name: '送出更正' }));
    expect(await screen.findByText(/請填寫更正原因/)).toBeInTheDocument();
    expect(api.correctCustomerBirthday).not.toHaveBeenCalled();
  });

  it('填了生日與原因才送得出去', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText('buyer@example.com'));
    await user.click(await screen.findByRole('button', { name: '修正生日' }));
    await user.type(screen.getByLabelText('更正後的生日'), '1990-02-03');
    await user.type(screen.getByLabelText('更正原因'), '顧客來信說填錯月份');
    await user.click(screen.getByRole('button', { name: '送出更正' }));
    await waitFor(() => expect(api.correctCustomerBirthday).toHaveBeenCalledWith(
      expect.any(String), { birthday: '1990-02-03', reason: '顧客來信說填錯月份' },
    ));
  });

  it('說明更正不補發已經錯過的生日禮券', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText('buyer@example.com'));
    await user.click(await screen.findByRole('button', { name: '修正生日' }));
    expect(await screen.findByText(/不會補發/)).toBeInTheDocument();
  });
});
