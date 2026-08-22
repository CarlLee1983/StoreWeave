import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PromotionsPage } from './PromotionsPage';
import { I18nProvider } from '../i18n';
import { api, type Promotion } from '../api';

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

const renderPage = () => render(<I18nProvider><PromotionsPage /></I18nProvider>);

beforeEach(() => {
  vi.mocked(api.listPromotions).mockReset().mockResolvedValue({ items: [promotion], total: 1 });
  vi.mocked(api.createPromotion).mockReset().mockResolvedValue(promotion);
  vi.mocked(api.updatePromotion).mockReset().mockResolvedValue(promotion);
  vi.mocked(api.setPromotionStatus).mockReset().mockResolvedValue({ ...promotion, status: 'disabled' });
});

describe('PromotionsPage', () => {
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

    await user.click(screen.getByRole('button', { name: '停用' }));

    await waitFor(() => expect(api.setPromotionStatus).toHaveBeenCalledWith(promotion.id, 'disabled'));
    expect(api.listPromotions).toHaveBeenCalledTimes(2);
  });

  it('已停用的活動可以重新啟用', async () => {
    vi.mocked(api.listPromotions).mockResolvedValue({ items: [{ ...promotion, status: 'disabled' }], total: 1 });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('滿千折百');

    await user.click(screen.getByRole('button', { name: '啟用' }));

    await waitFor(() => expect(api.setPromotionStatus).toHaveBeenCalledWith(promotion.id, 'active'));
  });

  it('後端的驗證錯誤顯示在畫面上', async () => {
    vi.mocked(api.createPromotion).mockRejectedValue(new Error('endsAt must be later than startsAt'));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('滿千折百');

    await user.type(screen.getByLabelText('活動名稱'), '倒著設的期間');
    await user.click(screen.getByRole('button', { name: '建立活動' }));

    expect(await screen.findByText(/endsAt must be later than startsAt/)).toBeInTheDocument();
  });
});

describe('PromotionsPage 編輯', () => {
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
    renderPage();
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
