import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SystemPage } from './SystemPage';
import { I18nProvider } from '../i18n';
import { api, type SalesSummary } from '../api';

/**
 * 銷售摘要區塊的現況迴歸網（工單 01）。
 *
 * 這個區塊目前藏在系統頁底下，Spec 0005 會把它搬到獨立的 Analytics 頁，
 * Spec 0002 會改變它的營收語意。搬家與語意變更前先把現況釘住。
 * 斷言刻意避開會隨語系變動的標籤文字，只認數字與資料本身。
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      healthDependencies: vi.fn(),
      listExtensions: vi.fn(),
      salesSummary: vi.fn(),
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

function renderPage() {
  return render(<I18nProvider><SystemPage /></I18nProvider>);
}

function dateInputs(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]'));
}

beforeEach(() => {
  vi.mocked(api.healthDependencies).mockReset().mockResolvedValue({ status: 'ok', checks: [] });
  vi.mocked(api.listExtensions).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(api.salesSummary).mockReset().mockResolvedValue(summary);
});

describe('SystemPage 的銷售摘要區塊', () => {
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
    expect(api.salesSummary).toHaveBeenCalledWith({ from, to });

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

  it('沒有資料時顯示零值與空的熱銷表格', async () => {
    vi.mocked(api.salesSummary).mockResolvedValue(empty);
    const { container } = renderPage();

    await waitFor(() => expect(api.salesSummary).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelectorAll('.summary-card').length).toBeGreaterThan(0));

    expect(container.querySelectorAll('.data-table tbody tr')).toHaveLength(0);
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(3);
  });

  it('查詢失敗時顯示錯誤而不是空白畫面', async () => {
    vi.mocked(api.salesSummary).mockRejectedValue(new Error('boom'));
    const { container } = renderPage();

    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    expect(container.querySelectorAll('.data-table tbody tr')).toHaveLength(0);
  });
});
