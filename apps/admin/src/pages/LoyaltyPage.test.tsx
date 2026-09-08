import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoyaltyPage } from './LoyaltyPage';
import { I18nProvider } from '../i18n';
import { api, type RewardSettings, type Tier } from '../api';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAdminQueryClient } from '../query';
import { AdminOperationProvider, createAdminOperationStore } from '../admin-operations';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { getRewardSettings: vi.fn(), updateRewardSettings: vi.fn(), listTiers: vi.fn(), saveTier: vi.fn(), removeTier: vi.fn() } };
});

const settings: RewardSettings = {
  accrualBasisPoints: 100, effectiveAfterDays: 7, expiresAfterDays: 365, expiryNoticeDays: 30,
  updatedAt: '2026-08-25T00:00:00.000Z',
};
const tiers: Tier[] = [
  { name: 'member', thresholdPoints: 0, multiplierBasisPoints: 10000 },
  { name: 'gold', thresholdPoints: 5000, multiplierBasisPoints: 15000 },
];

beforeEach(() => {
  vi.mocked(api.getRewardSettings).mockReset().mockResolvedValue(settings);
  vi.mocked(api.updateRewardSettings).mockReset().mockImplementation(async (body) => ({ ...settings, ...body } as RewardSettings));
  vi.mocked(api.listTiers).mockReset().mockResolvedValue({ items: tiers });
  vi.mocked(api.saveTier).mockReset().mockResolvedValue(tiers[1]);
  vi.mocked(api.removeTier).mockReset().mockResolvedValue({ items: [tiers[0]] });
});

const renderPage = (store = createAdminOperationStore()) => render(<QueryClientProvider client={createAdminQueryClient()}><AdminOperationProvider value={store}><I18nProvider><LoyaltyPage /></I18nProvider></AdminOperationProvider></QueryClientProvider>);

describe('LoyaltyPage（工單 72）', () => {
  it('等級讀取失敗時不以空清單開放等級異動', async () => {
    vi.mocked(api.listTiers).mockRejectedValue(new Error('tiers failed'));
    renderPage();
    await screen.findByText('tiers failed');
    expect(screen.queryByRole('button', { name: '儲存等級' })).not.toBeInTheDocument();
  });

  it('累積比例以百分比呈現，倍率以倍數呈現，不把基點攤給店員看', async () => {
    renderPage();
    expect((await screen.findByLabelText('購物金回饋（%）') as HTMLInputElement).value).toBe('1');
    expect((screen.getByLabelText('等級倍率（倍）') as HTMLInputElement).value).toBe('1');
    expect(screen.getByText('1.5')).toBeInTheDocument();
  });

  it('回饋百分比送出時換回基點', async () => {
    const user = userEvent.setup();
    renderPage();
    const accrual = await screen.findByLabelText('購物金回饋（%）');
    await user.clear(accrual);
    await user.type(accrual, '2.5');
    await user.click(screen.getByRole('button', { name: '儲存設定' }));
    await waitFor(() => expect(api.updateRewardSettings).toHaveBeenCalledWith({ accrualBasisPoints: 250 }, expect.any(String)));
  });

  it('沒有改動就不送出', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText('購物金回饋（%）');
    await user.click(screen.getByRole('button', { name: '儲存設定' }));
    expect(await screen.findByText(/沒有任何欄位被修改/)).toBeInTheDocument();
    expect(api.updateRewardSettings).not.toHaveBeenCalled();
  });

  it('購物金永不到期是明確的選項，不是把欄位留空', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText('購物金回饋（%）');
    await user.click(screen.getByLabelText('購物金永不到期'));
    await user.click(screen.getByRole('button', { name: '儲存設定' }));
    await waitFor(() => expect(api.updateRewardSettings).toHaveBeenCalledWith({ expiresAfterDays: null }, expect.any(String)));
  });

  it('設定儲存未知時由 recovery 重用原鍵與 sparse patch', async () => {
    vi.mocked(api.updateRewardSettings).mockRejectedValueOnce(new Error('network lost')).mockResolvedValueOnce({ ...settings, accrualBasisPoints: 250 });
    const user = userEvent.setup();
    renderPage();
    const accrual = await screen.findByLabelText('購物金回饋（%）');
    await user.clear(accrual);
    await user.type(accrual, '2.5');
    await user.click(screen.getByRole('button', { name: '儲存設定' }));
    await screen.findByText('network lost');
    const firstKey = vi.mocked(api.updateRewardSettings).mock.calls[0][1];
    await user.click(screen.getByRole('button', { name: '以原操作重試' }));
    await waitFor(() => expect(api.updateRewardSettings).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.updateRewardSettings).mock.calls[1]).toEqual([{ accrualBasisPoints: 250 }, firstKey]);
  });

  it('說明改動只影響之後的累積，不回溯既有帳本', async () => {
    renderPage();
    expect(await screen.findByText(/只影響之後的累積.*不回溯/)).toBeInTheDocument();
  });

  it.each([['1.005', '百分比只收到小數點後兩位'], ['2.675', '同上，四捨五入會靜默改掉輸入'], ['101', '超過 100%'], ['abc', '不是數字']])
    ('回饋填 %s 時擋在前端，不靜默送出一個被改過的數字', async (bad) => {
    const user = userEvent.setup();
    renderPage();
    const accrual = await screen.findByLabelText('購物金回饋（%）');
    await user.clear(accrual);
    await user.type(accrual, bad);
    await user.click(screen.getByRole('button', { name: '儲存設定' }));
    await waitFor(() => expect(screen.getByText(/回饋百分比/)).toBeInTheDocument());
    expect(api.updateRewardSettings).not.toHaveBeenCalled();
  });

  it('到期通知天數是零時擋在前端，不換一個英文 zod 400 回來', async () => {
    const user = userEvent.setup();
    renderPage();
    const notice = await screen.findByLabelText('到期前幾天通知');
    await user.clear(notice);
    await user.type(notice, '0');
    await user.click(screen.getByRole('button', { name: '儲存設定' }));
    await waitFor(() => expect(screen.getByText(/大於零/)).toBeInTheDocument());
    expect(api.updateRewardSettings).not.toHaveBeenCalled();
  });

  it('生效天數超過契約上界時擋在前端', async () => {
    const user = userEvent.setup();
    renderPage();
    const effective = await screen.findByLabelText('付款後幾天生效');
    await user.clear(effective);
    await user.type(effective, '400');
    await user.click(screen.getByRole('button', { name: '儲存設定' }));
    await waitFor(() => expect(screen.getByText(/365/)).toBeInTheDocument());
    expect(api.updateRewardSettings).not.toHaveBeenCalled();
  });

  it('說明門檻改動要等每日重算才反映在會員等級上', async () => {
    renderPage();
    expect(await screen.findByText(/每天重算一次/)).toBeInTheDocument();
  });

  it('等級同名視為修改，倍率換回基點送出', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('gold');
    await user.type(screen.getByLabelText('等級名稱'), 'gold');
    await user.type(screen.getByLabelText('門檻積分'), '8000');
    await user.clear(screen.getByLabelText('等級倍率（倍）'));
    await user.type(screen.getByLabelText('等級倍率（倍）'), '1.8');
    await user.click(screen.getByRole('button', { name: '儲存等級' }));
    await waitFor(() => expect(api.saveTier).toHaveBeenCalledWith({ name: 'gold', thresholdPoints: 8000, multiplierBasisPoints: 18000 }, expect.any(String)));
  });

  it('門檻為零的保底等級不給刪，按鈕根本不出現', async () => {
    renderPage();
    await screen.findByText('gold');
    const rows = screen.getAllByRole('row');
    const base = rows.find((row) => row.textContent?.includes('member'))!;
    const gold = rows.find((row) => row.textContent?.includes('gold'))!;
    expect(within(base).queryByRole('button', { name: '移除' })).not.toBeInTheDocument();
    expect(within(gold).getByRole('button', { name: '移除' })).toBeInTheDocument();
  });

  it('移除等級失敗時把伺服器的理由原樣顯示出來', async () => {
    const user = userEvent.setup();
    vi.mocked(api.removeTier).mockRejectedValue(new Error('Tier "gold" is still used by 2 promotion(s); update them first'));
    renderPage();
    await screen.findByText('gold');
    const gold = screen.getAllByRole('row').find((row) => row.textContent?.includes('gold'))!;
    await user.click(within(gold).getByRole('button', { name: '移除' }));
    await user.click(within(await screen.findByRole('dialog', { name: '移除 gold' })).getByRole('button', { name: '移除' }));
    expect(await screen.findByText(/still used by 2 promotion/)).toBeInTheDocument();
  });

  it('移除等級需在 Dialog 確認，Escape 關閉後焦點回到觸發鈕', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('gold');
    const gold = screen.getAllByRole('row').find((row) => row.textContent?.includes('gold'))!;

    const trigger = within(gold).getByRole('button', { name: '移除' });
    await user.click(trigger);
    expect(api.removeTier).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog', { name: '移除 gold' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '移除 gold' })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(within(await screen.findByRole('dialog', { name: '移除 gold' })).getByRole('button', { name: '移除' }));
    await waitFor(() => expect(api.removeTier).toHaveBeenCalledWith('gold', expect.any(String)));
  });

  it('同一等級的未知移除同時擋住新的儲存與移除，仍可重試原操作', async () => {
    const store = createAdminOperationStore();
    const operation = { area: 'loyalty', scope: 'loyalty-tier:gold', kind: 'tier-remove' as const, tierName: 'gold', request: { name: 'gold' }, preview: { name: 'gold' }, idempotencyKey: 'tier-remove-key' };
    store.markUnknown(store.begin(operation)!, new Error('remove uncertain'));
    const user = userEvent.setup();
    renderPage(store);
    await screen.findByText('gold');
    const gold = screen.getAllByRole('row').find((row) => row.textContent?.includes('gold'))!;
    expect(within(gold).getByRole('button', { name: '移除' })).toBeDisabled();
    await user.type(screen.getByLabelText('等級名稱'), 'gold');
    await user.type(screen.getByLabelText('門檻積分'), '8000');
    await user.clear(screen.getByLabelText('等級倍率（倍）'));
    await user.type(screen.getByLabelText('等級倍率（倍）'), '1.8');
    await user.click(screen.getByRole('button', { name: '儲存等級' }));
    expect(api.saveTier).not.toHaveBeenCalled();
    const retry = await screen.findByRole('button', { name: '以原操作重試' });
    expect(retry).toBeEnabled();
    await user.click(retry);
    await waitFor(() => expect(api.removeTier).toHaveBeenCalledWith('gold', 'tier-remove-key'));
  });
});
