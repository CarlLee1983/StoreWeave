import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PromotionsPage } from './PromotionsPage';
import { I18nProvider } from '../i18n';
import { api, type Promotion } from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: { listPromotions: vi.fn(), createPromotion: vi.fn(), setPromotionStatus: vi.fn() },
  };
});

const promotion: Promotion = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '滿千折百',
  status: 'active',
  rule: { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 10_000 },
  priority: 20,
  stackable: false,
  startsAt: '2026-09-01T00:00:00.000Z',
  endsAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-08-22T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
};

const renderPage = () => render(<I18nProvider><PromotionsPage /></I18nProvider>);

beforeEach(() => {
  vi.mocked(api.listPromotions).mockReset().mockResolvedValue({ items: [promotion], total: 1 });
  vi.mocked(api.createPromotion).mockReset().mockResolvedValue(promotion);
  vi.mocked(api.setPromotionStatus).mockReset().mockResolvedValue({ ...promotion, status: 'disabled' });
});

describe('PromotionsPage', () => {
  it('清單顯示型別、期間、狀態與優先序', async () => {
    renderPage();

    expect(await screen.findByText('滿千折百')).toBeInTheDocument();

    const row = screen.getByText('滿千折百').closest('tr')!;
    expect(row).toHaveTextContent('滿額折固定金額');
    expect(row).toHaveTextContent('20');
    expect(row).toHaveTextContent('上架中');
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
