import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PromotionsPage } from './PromotionsPage';
import { I18nProvider } from '../i18n';
import { ApiError, api, type Promotion } from '../api';
import { QueryClientProvider } from '@tanstack/react-query';
import { analyticsKeys, createAdminQueryClient } from '../query';
import { AdminOperationProvider, createAdminOperationStore } from '../admin-operations';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: { listPromotions: vi.fn(), createPromotion: vi.fn(), updatePromotion: vi.fn(), setPromotionStatus: vi.fn() },
  };
});

const promotion: Promotion = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '滿千折百',
  status: 'active',
  rule: { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 10_000 },
  priority: 20,
  stackable: false,
  requiresCoupon: false,
  autoIssue: null,
  autoIssueValidDays: null,
  startsAt: '2026-09-01T00:00:00.000Z',
  endsAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-08-22T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
};

const renderPage = (client = createAdminQueryClient()) => render(<QueryClientProvider client={client}><AdminOperationProvider value={createAdminOperationStore()}><I18nProvider><PromotionsPage /></I18nProvider></AdminOperationProvider></QueryClientProvider>);

beforeEach(() => {
  vi.mocked(api.listPromotions).mockReset().mockResolvedValue({ items: [promotion], total: 1 });
  vi.mocked(api.createPromotion).mockReset().mockResolvedValue(promotion);
  vi.mocked(api.updatePromotion).mockReset().mockResolvedValue(promotion);
  vi.mocked(api.setPromotionStatus).mockReset().mockResolvedValue({ ...promotion, status: 'disabled' });
});

describe('PromotionsPage', () => {
  it('讀取失敗不把活動表格偽裝成空資料', async () => {
    vi.mocked(api.listPromotions).mockRejectedValue(new Error('read failed'));
    renderPage();
    expect(await screen.findByText('read failed')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('清單顯示型別、期間、狀態與優先序', async () => {
    renderPage();

    expect(await screen.findByText('滿千折百')).toBeInTheDocument();

    const row = screen.getByText('滿千折百').closest('tr')!;
    expect(row).toHaveTextContent('滿額折固定金額');
    expect(row).toHaveTextContent('20');
    expect(row).toHaveTextContent('進行中');
    expect(row).toHaveTextContent(/2026/);
  });

  it('每種規則型別有專屬的表單欄位', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('滿千折百');

    window.dispatchEvent(new CustomEvent('admin:action:create-promotion', { cancelable: true }));
    await screen.findByRole('dialog', { name: '建立活動' });

    expect(screen.getByLabelText('門檻（cents）')).toBeInTheDocument();
    expect(screen.getByLabelText('折抵金額（cents）')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('規則型別'), 'threshold_percentage');
    expect(screen.getByLabelText('門檻（cents）')).toBeInTheDocument();
    expect(screen.getByLabelText('折扣百分比')).toBeInTheDocument();
    expect(screen.queryByLabelText('折抵金額（cents）')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('規則型別'), 'order_percentage');
    expect(screen.queryByLabelText('門檻（cents）')).not.toBeInTheDocument();
    expect(screen.getByLabelText('折扣百分比')).toBeInTheDocument();
  });

  it('參數不合法時給明確提示，而且不送出', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('滿千折百');

    window.dispatchEvent(new CustomEvent('admin:action:create-promotion', { cancelable: true }));
    await screen.findByRole('dialog', { name: '建立活動' });

    await user.type(screen.getByLabelText('活動名稱'), '折零元');
    await user.clear(screen.getByLabelText('折抵金額（cents）'));
    await user.type(screen.getByLabelText('折抵金額（cents）'), '0');
    await user.click(screen.getByRole('button', { name: '建立活動' }));

    expect(await screen.findByText(/折抵金額須大於零/)).toBeInTheDocument();
    expect(api.createPromotion).not.toHaveBeenCalled();
  });

  it('折扣百分比以百分比填寫，送出時換算成基點', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('滿千折百');

    window.dispatchEvent(new CustomEvent('admin:action:create-promotion', { cancelable: true }));
    await screen.findByRole('dialog', { name: '建立活動' });

    await user.type(screen.getByLabelText('活動名稱'), '全站九折');
    await user.selectOptions(screen.getByLabelText('規則型別'), 'order_percentage');
    await user.clear(screen.getByLabelText('折扣百分比'));
    await user.type(screen.getByLabelText('折扣百分比'), '10');
    await user.click(screen.getByRole('button', { name: '建立活動' }));

    await waitFor(() => expect(api.createPromotion).toHaveBeenCalled());
    expect(vi.mocked(api.createPromotion).mock.calls[0][0]).toMatchObject({
      name: '全站九折',
      rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
    });
  });

  it('可以停用進行中的活動，清單隨即重新載入', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('滿千折百');

    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    await user.click(await screen.findByRole('menuitem', { name: '停用' }));

    await waitFor(() => expect(api.setPromotionStatus).toHaveBeenCalledWith(promotion.id, 'disabled', expect.any(String)));
    expect(api.listPromotions).toHaveBeenCalledTimes(2);
  });

  it('已停用的活動可以重新啟用', async () => {
    vi.mocked(api.listPromotions).mockResolvedValue({ items: [{ ...promotion, status: 'disabled' }], total: 1 });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('滿千折百');

    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    await user.click(await screen.findByRole('menuitem', { name: '啟用' }));

    await waitFor(() => expect(api.setPromotionStatus).toHaveBeenCalledWith(promotion.id, 'active', expect.any(String)));
  });

  it('未知結果保留同一把操作鍵，從篩選外的 recovery 重試', async () => {
    vi.mocked(api.setPromotionStatus).mockRejectedValueOnce(new Error('network lost')).mockResolvedValueOnce({ ...promotion, status: 'disabled' });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('滿千折百');
    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    await user.click(await screen.findByRole('menuitem', { name: '停用' }));
    await screen.findByText('network lost');
    const firstKey = vi.mocked(api.setPromotionStatus).mock.calls[0][2];
    await user.click(screen.getByRole('button', { name: '以原操作重試' }));
    await waitFor(() => expect(api.setPromotionStatus).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.setPromotionStatus).mock.calls[1][2]).toBe(firstKey);
  });

  it('明確拒絕會解鎖，下一次明確操作使用新鍵', async () => {
    vi.mocked(api.setPromotionStatus).mockRejectedValueOnce(new ApiError('VALIDATION_ERROR', 'status rejected', 400)).mockResolvedValueOnce({ ...promotion, status: 'disabled' });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('滿千折百');
    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    await user.click(await screen.findByRole('menuitem', { name: '停用' }));
    expect(await screen.findByText('status rejected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    await user.click(await screen.findByRole('menuitem', { name: '停用' }));
    await waitFor(() => expect(api.setPromotionStatus).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.setPromotionStatus).mock.calls[1][2]).not.toBe(vi.mocked(api.setPromotionStatus).mock.calls[0][2]);
  });

  it('後端的驗證錯誤顯示在畫面上', async () => {
    vi.mocked(api.createPromotion).mockRejectedValue(new Error('endsAt must be later than startsAt'));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('滿千折百');

    window.dispatchEvent(new CustomEvent('admin:action:create-promotion', { cancelable: true }));
    const dialog = await screen.findByRole('dialog', { name: '建立活動' });

    await user.type(within(dialog).getByLabelText('活動名稱'), '倒著設的期間');
    await user.click(within(dialog).getByRole('button', { name: '建立活動' }));

    expect(await screen.findByText(/endsAt must be later than startsAt/)).toBeInTheDocument();
  });
});

describe('PromotionsPage 建立活動抽屜', () => {
  it('建立表單不再常駐佔版面，由頁首的建立活動開啟', async () => {
    renderPage();
    await screen.findByText('滿千折百');
    expect(screen.queryByLabelText('活動名稱')).not.toBeInTheDocument();

    window.dispatchEvent(new CustomEvent('admin:action:create-promotion', { cancelable: true }));
    expect(await screen.findByRole('dialog', { name: '建立活動' })).toBeInTheDocument();
  });
});

describe('PromotionsPage 編輯', () => {
  it('編輯 Dialog 用 Escape 關閉後焦點回到編輯鈕', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('滿千折百');

    const trigger = screen.getByRole('button', { name: '編輯' });
    await user.click(trigger);
    expect(await screen.findByRole('dialog', { name: '編輯' })).toBeInTheDocument();
    expect(screen.getByLabelText('活動名稱')).toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '編輯' })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('編輯表單帶出這檔活動目前的參數與期間', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('滿千折百');

    await user.click(screen.getByRole('button', { name: '編輯' }));

    const form = screen.getByRole('form', { name: '編輯 滿千折百' });
    expect(form).toHaveTextContent('滿額折固定金額');
    expect(within(form).getByLabelText('活動名稱')).toHaveValue('滿千折百');
    expect(within(form).getByLabelText('門檻（cents）')).toHaveValue('100000');
    expect(within(form).getByLabelText('折抵金額（cents）')).toHaveValue('10000');
    expect(within(form).getByLabelText('優先序')).toHaveValue('20');
    expect(within(form).getByLabelText('可與其他活動疊加')).not.toBeChecked();
    // datetime-local 是本地時間，值本身依時區而異；重點是它帶得出來、而且送得回同一個時刻
    expect(within(form).getByLabelText('開始時間')).not.toHaveValue('');
  });

  it('改完參數送出會呼叫 updatePromotion 並重新載入清單', async () => {
    const user = userEvent.setup();
    const client = createAdminQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    renderPage(client);
    await screen.findByText('滿千折百');

    await user.click(screen.getByRole('button', { name: '編輯' }));
    const form = screen.getByRole('form', { name: '編輯 滿千折百' });
    await user.clear(within(form).getByLabelText('折抵金額（cents）'));
    await user.type(within(form).getByLabelText('折抵金額（cents）'), '20000');
    await user.click(within(form).getByRole('button', { name: '儲存變更' }));

    await waitFor(() => expect(api.updatePromotion).toHaveBeenCalled());
    const [id, body] = vi.mocked(api.updatePromotion).mock.calls[0];
    expect(id).toBe(promotion.id);
    expect(body).toMatchObject({
      name: '滿千折百',
      priority: 20,
      stackable: false,
      rule: { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 20_000 },
    });
    // 沒有動到期間，就要送回原本的那個時刻
    expect(new Date(body.startsAt!).toISOString()).toBe(promotion.startsAt);
    expect(new Date(body.endsAt!).toISOString()).toBe(promotion.endsAt);
    expect(api.listPromotions).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: analyticsKeys.promotionPerformances });
  });

  it('編輯時參數不合法一樣擋下來', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('滿千折百');

    await user.click(screen.getByRole('button', { name: '編輯' }));
    const form = screen.getByRole('form', { name: '編輯 滿千折百' });
    await user.clear(within(form).getByLabelText('折抵金額（cents）'));
    await user.type(within(form).getByLabelText('折抵金額（cents）'), '0');
    await user.click(within(form).getByRole('button', { name: '儲存變更' }));

    expect(await screen.findByText(/折抵金額須大於零/)).toBeInTheDocument();
    expect(api.updatePromotion).not.toHaveBeenCalled();
  });

  it('取消編輯會關掉表單', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('滿千折百');

    await user.click(screen.getByRole('button', { name: '編輯' }));
    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(screen.queryByRole('form', { name: '編輯 滿千折百' })).not.toBeInTheDocument();
  });
});

describe('活動期間的先後', () => {
  const openDrawer = () =>
    window.dispatchEvent(new CustomEvent('admin:action:create-promotion', { cancelable: true }));

  it('結束時間早於開始時間就擋下來，不必等後端退回', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('滿千折百');
    openDrawer();

    const dialog = await screen.findByRole('dialog', { name: '建立活動' });
    await user.type(within(dialog).getByLabelText('活動名稱'), '錯誤檔期');
    // 日期輸入逐字打在 jsdom 會留下中間狀態，直接給完整值才是瀏覽器裡的行為。
    fireEvent.change(within(dialog).getByLabelText('開始時間'), { target: { value: '2026-09-10' } });
    fireEvent.change(within(dialog).getByLabelText('結束時間'), { target: { value: '2026-09-01' } });
    await user.click(screen.getByRole('button', { name: '建立活動' }));

    expect(await screen.findByText(/結束時間必須晚於開始時間/)).toBeInTheDocument();
    expect(api.createPromotion).not.toHaveBeenCalled();
  });

  it('結束時間的日曆不給選開始之前的日子', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('滿千折百');
    openDrawer();

    const dialog = await screen.findByRole('dialog', { name: '建立活動' });
    fireEvent.change(within(dialog).getByLabelText('開始時間'), { target: { value: '2026-09-10' } });
    await user.click(within(dialog).getByRole('button', { name: '結束時間：選擇日期' }));

    // 日曆從界線那個月（9 月）打開：9/5 在開始之前不能選，9/20 之後可以。
    const calendar = await screen.findByRole('dialog', { name: '結束時間：選擇日期' });
    expect(within(calendar).getByText('2026年9月')).toBeInTheDocument();
    expect(within(calendar).getByText('5').closest('button')).toBeDisabled();
    expect(within(calendar).getByText('20').closest('button')).not.toBeDisabled();
  });
});
