import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CustomersPage } from './CustomersPage';
import { I18nProvider } from '../i18n';
import { ApiError, api, type AdminCustomer, type AdminCustomerDetail, type CustomerLoyalty } from '../api';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAdminQueryClient } from '../query';
import { AdminOperationProvider, createAdminOperationStore } from '../admin-operations';

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

const renderPage = (store = createAdminOperationStore()) => render(<QueryClientProvider client={createAdminQueryClient()}><AdminOperationProvider value={store}><I18nProvider><CustomersPage /></I18nProvider></AdminOperationProvider></QueryClientProvider>);

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
    expect(row).toHaveTextContent('啟用中');
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

    await waitFor(() => expect(api.getCustomer).toHaveBeenCalledWith(customer.id, expect.any(AbortSignal)));
    expect(await screen.findByText('SW-1001')).toBeInTheDocument();
    expect(screen.getByText('1990-05-20')).toBeInTheDocument();
  });

  it('停用會員後重新載入清單', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('buyer@example.com');

    await user.click(screen.getByRole('button', { name: '停用' }));

    await waitFor(() => expect(api.setCustomerStatus).toHaveBeenCalledWith(customer.id, 'disabled', expect.any(String)));
    expect(api.listCustomers).toHaveBeenCalledTimes(2);
  });

  it('已停用的會員可以重新啟用', async () => {
    vi.mocked(api.listCustomers).mockResolvedValue({ items: [{ ...customer, status: 'disabled' }], total: 1 });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('buyer@example.com');

    await user.click(screen.getByRole('button', { name: '啟用' }));

    await waitFor(() => expect(api.setCustomerStatus).toHaveBeenCalledWith(customer.id, 'active', expect.any(String)));
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
  it.each([
    ['adjustRewards', '調整購物金', '5000', 0, { id: 'entry-3' }],
    ['adjustTierPoints', '調整等級積分', '50', 1, { points: 4250 }],
  ] as const)('%s 終態拒絕後保留原始草稿並換新鑰匙', async (method, label, amount, index, result) => {
    const user = userEvent.setup();
    vi.mocked(api[method]).mockRejectedValueOnce(new ApiError('VALIDATION_ERROR', '終態拒絕', 422)).mockResolvedValueOnce(result as never);
    renderPage();
    await user.click(await screen.findByText('buyer@example.com'));
    await user.type(screen.getByLabelText(label), amount);
    await user.type(screen.getAllByLabelText('原因')[index], '  原始理由  ');
    await user.click(screen.getAllByRole('button', { name: '調整' })[index]);
    await screen.findByText(/終態拒絕/);
    expect(screen.getByLabelText(label)).toHaveValue(amount);
    expect(screen.getByLabelText(label)).not.toBeDisabled();
    await user.click(screen.getAllByRole('button', { name: '調整' })[index]);
    await waitFor(() => expect(api[method]).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api[method]).mock.calls[1][2]).not.toBe(vi.mocked(api[method]).mock.calls[0][2]);
  });

  it.each([
    ['adjustRewards', '調整購物金', '5000', '補償'],
    ['adjustTierPoints', '調整等級積分', '50', '修正'],
  ] as const)('%s 在 pending 時連點只送一次', async (method, label, amount, reason) => {
    const user = userEvent.setup();
    let resolve!: (value: { id: string } | { points: number }) => void;
    vi.mocked(api[method]).mockImplementationOnce(() => new Promise((done) => { resolve = done; }) as never);
    renderPage();
    await user.click(await screen.findByText('buyer@example.com'));
    await screen.findByText('銀卡（4200）');

    const index = method === 'adjustRewards' ? 0 : 1;
    await user.type(screen.getByLabelText(label), amount);
    await user.type(screen.getAllByLabelText('原因')[index], reason);
    await user.dblClick(screen.getAllByRole('button', { name: '調整' })[index]);

    expect(api[method]).toHaveBeenCalledTimes(1);
    resolve(method === 'adjustRewards' ? { id: 'entry-2' } : { points: 4250 });
  });

  it('timeout 後鎖住同一份調帳 payload 與鑰匙，不會改內容再送第二筆', async () => {
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

    const amount = screen.getByLabelText('調整購物金');
    const reason = screen.getAllByLabelText('原因')[0];
    expect(amount).toBeDisabled();
    expect(reason).toBeDisabled();
    await user.type(amount, '999');
    await user.type(reason, '改成其他原因');
    expect(amount).toHaveValue('5000');
    expect(reason).toHaveValue('補償');
    await user.click(screen.getByRole('button', { name: '以原操作重試' }));

    await waitFor(() => expect(api.adjustRewards).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(api.adjustRewards).mock.calls;
    expect(second[1]).toEqual(first[1]);
    expect(second[2]).toBe(first[2]);
  });

  it.each([
    ['adjustRewards', '調整購物金', ' 05000 ', 0, '  客訴補償  ', { id: 'entry-4' }],
    ['adjustTierPoints', '調整等級積分', ' 0050 ', 1, '  重算修正  ', { points: 4250 }],
  ] as const)('%s 的未知 recovery 終態拒絕後保留原始草稿並讓下一次操作換新鑰匙', async (method, label, rawAmount, index, rawReason, result) => {
    const user = userEvent.setup();
    vi.mocked(api[method]).mockRejectedValueOnce(new TypeError('network unknown')).mockRejectedValueOnce(new ApiError('VALIDATION_ERROR', 'recovery rejected', 422)).mockResolvedValueOnce(result as never);
    renderPage();
    await user.click(await screen.findByText('buyer@example.com'));
    await screen.findByText('銀卡（4200）');
    await user.type(screen.getByLabelText(label), rawAmount);
    await user.type(screen.getAllByLabelText('原因')[index], rawReason);
    await user.click(screen.getAllByRole('button', { name: '調整' })[index]);
    await screen.findByText('network unknown');

    const first = vi.mocked(api[method]).mock.calls[0];
    await user.click(screen.getByRole('button', { name: '以原操作重試' }));
    expect(await screen.findByText('recovery rejected')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(label)).toHaveValue(rawAmount));
    expect(screen.getByLabelText(label)).toBeEnabled();
    expect(screen.getAllByLabelText('原因')[index]).toHaveValue(rawReason);
    expect(screen.getAllByLabelText('原因')[index]).toBeEnabled();

    const retry = vi.mocked(api[method]).mock.calls[1];
    expect(retry[1]).toEqual(first[1]);
    expect(retry[2]).toBe(first[2]);
    await user.click(screen.getAllByRole('button', { name: '調整' })[index]);
    await waitFor(() => expect(api[method]).toHaveBeenCalledTimes(3));
    const next = vi.mocked(api[method]).mock.calls[2];
    expect(next[1]).toEqual(first[1]);
    expect(next[2]).not.toBe(first[2]);
  });

  it('未知調帳在收合會員列後仍顯示原操作並用同一把鑰匙重試', async () => {
    const user = userEvent.setup();
    vi.mocked(api.adjustRewards).mockRejectedValueOnce(new Error('timeout'));
    renderPage();
    await user.click(await screen.findByText('buyer@example.com'));
    await user.type(screen.getByLabelText('調整購物金'), ' 05000 ');
    await user.type(screen.getAllByLabelText('原因')[0], '  補償  ');
    await user.click(screen.getAllByRole('button', { name: '調整' })[0]);
    await screen.findByText(/timeout/);
    await user.click(screen.getByText('buyer@example.com'));

    expect(await screen.findByRole('button', { name: '以原操作重試' })).toBeInTheDocument();
    expect(screen.getByText(/\$50\.00/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '以原操作重試' }));
    await waitFor(() => expect(api.adjustRewards).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(api.adjustRewards).mock.calls;
    expect(calls[1][1]).toEqual(calls[0][1]);
    expect(calls[1][2]).toBe(calls[0][2]);
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
      customer.id, { birthday: '1990-02-03', reason: '顧客來信說填錯月份' }, expect.any(String),
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

describe('會員狀態的語彙', () => {
  it('帳號是啟用中，不是「上架中」——那是商品的說法', async () => {
    renderPage();
    expect(await screen.findByText('buyer@example.com')).toBeInTheDocument();
    expect(screen.queryByText('上架中')).not.toBeInTheDocument();
    const row = screen.getByText('buyer@example.com').closest('tr')!;
    expect(row).toHaveTextContent('啟用中');
  });
});
