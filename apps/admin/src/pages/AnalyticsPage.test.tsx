import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AnalyticsPage } from './AnalyticsPage';
import { I18nProvider } from '../i18n';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAdminQueryClient } from '../query';
import {
  api,
  type AttributionSummary,
  type OutstandingRewards,
  type PromotionPerformance,
  type SalesSummary,
} from '../api';

/**
 * 行銷分析頁（工單 47）。
 *
 * 銷售摘要的斷言是工單 01 那張現況迴歸網，逐字搬過來——這一頁的成立條件
 * 就是「搬家沒有改壞它」。斷言刻意避開會隨語系變動的標籤文字，只認數字與資料本身。
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      salesSummary: vi.fn(),
      promotionPerformance: vi.fn(),
      partnerPerformance: vi.fn(),
      outstandingRewards: vi.fn(),
    },
  };
});

const summary: SalesSummary = {
  currency: 'TWD',
  paidOrderCount: 7,
  pendingOrderCount: 3,
  cancelledOrderCount: 2,
  grossRevenueCents: 123_400,
  averageOrderValueCents: 61_700,
  topProducts: [
    { productId: 'p-1', sku: 'SKU-ALPHA', name: '熱銷商品甲', quantity: 9, revenueCents: 98_700 },
    { productId: 'p-2', sku: 'SKU-BETA', name: '熱銷商品乙', quantity: 4, revenueCents: 34_500 },
  ],
};

const empty: SalesSummary = {
  currency: 'TWD',
  paidOrderCount: 0,
  pendingOrderCount: 0,
  cancelledOrderCount: 0,
  grossRevenueCents: 0,
  averageOrderValueCents: 0,
  topProducts: [],
};

const promotionPerformance: PromotionPerformance[] = [
  { promotionId: 'promo-1', name: '夏季八折', redemptionCount: 12, orderCount: 11, discountCents: 45_600, revenueCents: 320_000 },
];

const partners: AttributionSummary[] = [
  { partnerCode: 'STREAMER-A', orderCount: 5, revenueCents: 150_000, discountCents: 15_000 },
];

const outstanding: OutstandingRewards = { currency: 'TWD', availableCents: 88_000, pendingCents: 12_000, customerCount: 42 };

function renderPage() {
  return render(<QueryClientProvider client={createAdminQueryClient()}><I18nProvider><AnalyticsPage /></I18nProvider></QueryClientProvider>);
}

function dateInputs(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]'));
}

beforeEach(() => {
  vi.mocked(api.salesSummary).mockReset().mockResolvedValue(summary);
  vi.mocked(api.promotionPerformance).mockReset().mockResolvedValue({ currency: 'TWD', items: promotionPerformance });
  vi.mocked(api.partnerPerformance).mockReset().mockResolvedValue({ currency: 'TWD', items: partners });
  vi.mocked(api.outstandingRewards).mockReset().mockResolvedValue(outstanding);
});

describe('銷售摘要（搬家自系統頁，行為不變）', () => {
  it('顯示訂單計數、營收、客單價與熱銷商品', async () => {
    renderPage();

    expect(await screen.findByText('7')).toBeInTheDocument();  // 已付款訂單數
    expect(screen.getByText('3')).toBeInTheDocument();          // 待付款
    expect(screen.getByText('2')).toBeInTheDocument();          // 已取消
    expect(screen.getByText(/1,234/)).toBeInTheDocument();      // 總營收 123400 分
    expect(screen.getByText(/617/)).toBeInTheDocument();        // 客單價 61700 分

    expect(screen.getByText('SKU-ALPHA')).toBeInTheDocument();
    expect(screen.getByText('熱銷商品甲')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText(/987/)).toBeInTheDocument();
    expect(screen.getByText('SKU-BETA')).toBeInTheDocument();
    expect(screen.getByText(/345/)).toBeInTheDocument();
  });

  it('預設查詢最近三十天，且結束日不早於開始日', async () => {
    const { container } = renderPage();
    await screen.findByText('7');

    expect(api.salesSummary).toHaveBeenCalledTimes(1);
    const [from, to] = dateInputs(container).map((input) => input.value);
    expect(api.salesSummary).toHaveBeenCalledWith({ from, to }, expect.anything());

    const spanDays = (Date.parse(to) - Date.parse(from)) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBe(30);
  });

  it('改變期間會用新的區間重新查詢', async () => {
    const { container } = renderPage();
    await screen.findByText('7');

    const [fromInput] = dateInputs(container);
    fireEvent.change(fromInput, { target: { value: '2026-01-01' } });

    await waitFor(() => expect(api.salesSummary).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.salesSummary).mock.calls[1][0]).toMatchObject({ from: '2026-01-01' });
  });

  it('沒有資料時顯示零值與熱銷商品空狀態', async () => {
    vi.mocked(api.salesSummary).mockResolvedValue(empty);
    const { container } = renderPage();

    await waitFor(() => expect(api.salesSummary).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelectorAll('.summary-card').length).toBeGreaterThan(0));

    expect(await screen.findByText('這段期間尚無商品銷售資料。')).toBeInTheDocument();
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(3);
  });

  it('查詢失敗時顯示錯誤而不是空白畫面', async () => {
    vi.mocked(api.salesSummary).mockRejectedValue(new Error('boom'));
    const { container } = renderPage();

    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    expect(container.querySelectorAll('.panel')[0].querySelectorAll('.data-table tbody tr')).toHaveLength(0);
  });

  it('已成功的摘要在日期變更後讀取失敗時顯示該次錯誤，不影響其他分析區塊', async () => {
    vi.mocked(api.salesSummary).mockReset().mockResolvedValueOnce(summary).mockRejectedValueOnce(new Error('later summary unavailable'));
    const { container } = renderPage();
    await screen.findByText('SKU-ALPHA');

    fireEvent.change(dateInputs(container)[0], { target: { value: '2026-01-01' } });

    await waitFor(() => expect(api.salesSummary).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('later summary unavailable')).toBeInTheDocument();
    expect(container.querySelectorAll('.panel')[0].querySelectorAll('.data-table tbody tr')).toHaveLength(0);
    expect(screen.getByText('夏季八折')).toBeInTheDocument();
    expect(screen.getByText('STREAMER-A')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });
});

describe('活動成效', () => {
  it('列出每一檔活動的核銷次數、訂單數、折抵與營收', async () => {
    renderPage();

    const row = (await screen.findByText('夏季八折')).closest('tr')!;
    expect(row).toHaveTextContent('12');
    expect(row).toHaveTextContent('11');
  });

  it('沒有核銷時說出來，而不是給一張空表格', async () => {
    vi.mocked(api.promotionPerformance).mockResolvedValue({ currency: 'TWD', items: [] });
    renderPage();

    expect(await screen.findByText('這段期間沒有任何核銷。')).toBeInTheDocument();
  });

  it('與銷售摘要共用同一組期間：改一次日期，兩邊都重新查', async () => {
    const { container } = renderPage();
    await screen.findByText('夏季八折');

    fireEvent.change(dateInputs(container)[0], { target: { value: '2026-01-01' } });

    await waitFor(() => expect(api.promotionPerformance).toHaveBeenCalledTimes(2));
    expect(api.salesSummary).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.promotionPerformance).mock.calls[1][0]).toMatchObject({ from: '2026-01-01' });
  });
});

describe('行銷碼成效', () => {
  it('依合作夥伴分組，並說明佣金要人工結算', async () => {
    renderPage();

    const row = (await screen.findByText('STREAMER-A')).closest('tr')!;
    expect(row).toHaveTextContent('5');
    expect(screen.getByText(/結算靠人工/)).toBeInTheDocument();
  });

  it('沒有帶歸因的核銷時說出來', async () => {
    vi.mocked(api.partnerPerformance).mockResolvedValue({ currency: 'TWD', items: [] });
    renderPage();

    expect(await screen.findByText('這段期間沒有帶歸因的核銷。')).toBeInTheDocument();
  });
});

describe('流通在外的購物金', () => {
  it('把已生效與未生效分開講，並說明它是一本負債帳', async () => {
    renderPage();

    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(screen.getByText(/負債帳/)).toBeInTheDocument();
  });

  it('它不隨查詢期間變動——負債是「現在」的數字', async () => {
    const { container } = renderPage();
    await screen.findByText('42');

    fireEvent.change(dateInputs(container)[0], { target: { value: '2026-01-01' } });

    await waitFor(() => expect(api.salesSummary).toHaveBeenCalledTimes(2));
    expect(api.outstandingRewards).toHaveBeenCalledTimes(1);
  });
});

describe('查詢區間', () => {
  it('把結束日拉到開始日之前，就把開始日一起帶過去，不會查出一段負區間', async () => {
    renderPage();
    await screen.findByText(/銷售摘要|Sales/);

    const from = screen.getByLabelText('從') as HTMLInputElement;
    const to = screen.getByLabelText('到') as HTMLInputElement;
    fireEvent.change(from, { target: { value: '2026-08-20' } });
    fireEvent.change(to, { target: { value: '2026-08-10' } });

    await waitFor(() => expect(new Date(to.value).getTime()).toBeGreaterThanOrEqual(new Date(from.value).getTime()));
  });
});
