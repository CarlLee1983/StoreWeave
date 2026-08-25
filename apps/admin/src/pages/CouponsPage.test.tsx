import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CouponsPage } from './CouponsPage';
import { I18nProvider } from '../i18n';
import { api, type Coupon, type Promotion } from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      listCoupons: vi.fn(), listPromotions: vi.fn(), createCoupon: vi.fn(),
      issueCoupons: vi.fn(), setCouponStatus: vi.fn(),
    },
  };
});

const promotion: Promotion = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '夏季八折',
  status: 'active',
  rule: { type: 'order_percentage', percentOffBasisPoints: 2_000, maxDiscountCents: null },
  priority: 0,
  stackable: true,
  requiresCoupon: true,
  autoIssue: null,
  autoIssueValidDays: null,
  startsAt: null,
  endsAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

/** 人人適用的活動不該出現在券的下拉選單裡。 */
const openPromotion: Promotion = { ...promotion, id: '22222222-2222-4222-8222-222222222222', name: '全站滿千折百', requiresCoupon: false };

const coupon: Coupon = {
  id: '33333333-3333-4333-8333-333333333333',
  code: 'SUMMER20',
  promotionId: promotion.id,
  status: 'issued',
  customerId: null,
  partnerCode: null,
  maxRedemptions: 100,
  redeemedCount: 7,
  perCustomerLimit: 1,
  source: 'manual',
  batchId: null,
  startsAt: null,
  endsAt: '2026-12-31T00:00:00.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const renderPage = () => render(<I18nProvider><CouponsPage /></I18nProvider>);

beforeEach(() => {
  vi.mocked(api.listCoupons).mockReset().mockResolvedValue({ items: [coupon], total: 1 });
  vi.mocked(api.listPromotions).mockReset().mockResolvedValue({ items: [promotion, openPromotion], total: 2 });
  vi.mocked(api.createCoupon).mockReset().mockResolvedValue(coupon);
  vi.mocked(api.issueCoupons).mockReset().mockResolvedValue({ batchId: 'b', issued: 42, skipped: 3 });
  vi.mocked(api.setCouponStatus).mockReset().mockResolvedValue({ ...coupon, status: 'void' });
});

describe('CouponsPage', () => {
  it('清單顯示型別、活動、期間、限量與已使用次數', async () => {
    renderPage();

    const row = (await screen.findByText('SUMMER20')).closest('tr')!;
    expect(row).toHaveTextContent('公開共用碼');
    expect(row).toHaveTextContent('夏季八折');
    expect(row).toHaveTextContent('7 / 100');
  });

  it('實發券與行銷碼看得出差別', async () => {
    vi.mocked(api.listCoupons).mockResolvedValue({
      items: [
        { ...coupon, id: 'a', code: 'MINE', customerId: '44444444-4444-4444-8444-444444444444' },
        { ...coupon, id: 'b', code: 'INFLU', partnerCode: 'STREAMER-A' },
      ],
      total: 2,
    });
    renderPage();

    expect((await screen.findByText('MINE')).closest('tr')).toHaveTextContent('實發券');
    const marketing = (await screen.findByText('INFLU')).closest('tr')!;
    expect(marketing).toHaveTextContent('行銷碼');
    expect(marketing).toHaveTextContent('STREAMER-A');
  });

  it('不限量時只說用了幾次，不顯示上限', async () => {
    vi.mocked(api.listCoupons).mockResolvedValue({ items: [{ ...coupon, maxRedemptions: null, redeemedCount: 3 }], total: 1 });
    renderPage();

    const row = (await screen.findByText('SUMMER20')).closest('tr')!;
    // 用量那一格：不限量時只有次數，沒有「3 / ∞」這種讀起來像壞掉的畫面。
    const usage = row.querySelectorAll('td')[4];
    expect(usage.textContent).toBe('3');
  });

  it('建立表單改由抽屜開啟：頁首動作事件會開抽屜而不是捲動頁面', async () => {
    renderPage();
    await screen.findByText('SUMMER20');

    expect(screen.queryByLabelText('折扣碼')).not.toBeInTheDocument();
    window.dispatchEvent(new CustomEvent('admin:action:create-coupon', { cancelable: true }));

    expect(await screen.findByLabelText('折扣碼')).toBeInTheDocument();
  });

  it('可以自訂字樣建立公開碼，碼一律轉大寫送出', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('SUMMER20');

    window.dispatchEvent(new CustomEvent('admin:action:create-coupon', { cancelable: true }));
    await user.type(await screen.findByLabelText('折扣碼'), 'autumn10');
    await user.selectOptions(screen.getByLabelText('活動名稱'), promotion.id);
    await user.type(screen.getByLabelText('總使用次數上限（留空為不限）'), '50');
    await user.click(screen.getByRole('button', { name: '建立' }));

    await waitFor(() => expect(api.createCoupon).toHaveBeenCalledWith(expect.objectContaining({
      code: 'AUTUMN10',
      promotionId: promotion.id,
      maxRedemptions: 50,
      perCustomerLimit: 1,
    })));
  });

  it('只有「需要券」的活動能被選', async () => {
    renderPage();
    await screen.findByText('SUMMER20');
    window.dispatchEvent(new CustomEvent('admin:action:create-coupon', { cancelable: true }));

    const options = (await screen.findByLabelText('活動名稱')).querySelectorAll('option');
    const labels = [...options].map((o) => o.textContent);
    expect(labels).toContain('夏季八折');
    expect(labels).not.toContain('全站滿千折百');
  });

  it('參數不合法時給提示，而且不送出', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('SUMMER20');
    window.dispatchEvent(new CustomEvent('admin:action:create-coupon', { cancelable: true }));

    await user.click(await screen.findByRole('button', { name: '建立' }));

    expect(await screen.findByText(/請填寫折扣碼/)).toBeInTheDocument();
    expect(api.createCoupon).not.toHaveBeenCalled();
  });

  it('批次發券由工具列按鈕開啟抽屜，發放之後看得到發了幾張、略過幾張', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('SUMMER20');

    expect(screen.queryByLabelText('發券活動')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /批次發券/ }));

    await user.selectOptions(await screen.findByLabelText('發券活動'), promotion.id);
    await user.click(screen.getByRole('button', { name: '發放' }));

    await waitFor(() => expect(api.issueCoupons).toHaveBeenCalledWith(expect.objectContaining({ promotionId: promotion.id })));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('42');
    expect(status).toHaveTextContent('3');
  });

  it('停用一組碼會立刻重新載入清單', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('SUMMER20');

    await user.click(screen.getByRole('button', { name: '停用' }));

    await waitFor(() => expect(api.setCouponStatus).toHaveBeenCalledWith(coupon.id, 'void'));
    await waitFor(() => expect(api.listCoupons).toHaveBeenCalledTimes(2));
  });

  it('沒有券時顯示空狀態', async () => {
    vi.mocked(api.listCoupons).mockResolvedValue({ items: [], total: 0 });
    renderPage();

    expect(await screen.findByText('目前沒有券。')).toBeInTheDocument();
  });
});
