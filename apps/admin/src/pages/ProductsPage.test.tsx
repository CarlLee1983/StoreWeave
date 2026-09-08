import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { ProductsPage } from './ProductsPage';
import { I18nProvider } from '../i18n';
import { ApiError, api, type Product, type Stock } from '../api';
import { createAdminQueryClient } from '../query';
import { createAdminOperationStore, AdminOperationProvider, type AdminOperationStore as ProductOperationStore } from '../admin-operations';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { listProducts: vi.fn(), listInventory: vi.fn(), createProduct: vi.fn(), patchProduct: vi.fn(), adjustInventory: vi.fn() } };
});

const draft: Product = {
  id: '11111111-1111-4111-8111-111111111111', sku: 'SKU-DRAFT', name: '藍色帆布鞋', description: '帆布鞋',
  priceCents: 120000, currency: 'TWD', status: 'draft', createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
};
const stock: Stock = { productId: draft.id, onHand: 10, reserved: 2, available: 8, updatedAt: '2026-08-25T00:00:00.000Z' };

beforeEach(() => {
  localStorage.setItem('storeweave.admin.locale', 'zh-TW');
  vi.mocked(api.listProducts).mockReset().mockResolvedValue({ items: [draft], total: 1 });
  vi.mocked(api.listInventory).mockReset().mockResolvedValue({ items: [stock], total: 1 });
  vi.mocked(api.createProduct).mockReset().mockResolvedValue(draft);
  vi.mocked(api.patchProduct).mockReset().mockImplementation(async (_id, body) => ({ ...draft, ...body }));
  vi.mocked(api.adjustInventory).mockReset().mockResolvedValue(stock);
});

describe('商品清單的語系與計數範圍', () => {
  it.each([
    ['zh-TW', '篩選結果總數', '本頁草稿', '顯示第 1–20 筆，共 41 筆篩選結果', '第 1 / 3 頁', '編輯', '預覽：'],
    ['en-US', 'Filtered products', 'Draft on this page', 'Showing 1–20 of 41 filtered products', 'Page 1 of 3', 'Edit', 'Preview:'],
    ['ja-JP', '絞り込み結果の合計', 'このページの下書き', '1–20 件を表示（絞り込み結果 41 件）', '1 / 3 ページ', '編集', 'プレビュー：'],
  ] as const)('shows scoped summary, pagination, and price preview in %s', async (locale, totalLabel, pageLabel, range, page, edit, pricePreview) => {
    const user = userEvent.setup();
    localStorage.setItem('storeweave.admin.locale', locale);
    vi.mocked(api.listProducts).mockResolvedValue({ items: [draft], total: 41 });
    renderPage();

    await screen.findByText(draft.name);
    expect(screen.getByText(totalLabel)).toBeInTheDocument();
    expect(screen.getByText(pageLabel)).toBeInTheDocument();
    expect(screen.getByText(range)).toBeInTheDocument();
    expect(screen.getByText(page)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: edit }));
    expect(document.querySelector('.price-preview-badge')).toHaveTextContent(pricePreview);
  });
});

const renderPage = ({ client = createAdminQueryClient(), store = createAdminOperationStore() }: { client?: QueryClient; store?: ProductOperationStore } = {}) => render(
  <QueryClientProvider client={client}>
    <AdminOperationProvider value={store}><I18nProvider><ProductsPage /></I18nProvider></AdminOperationProvider>
  </QueryClientProvider>,
);

/** 次要動作收在每列的 ⋯ 選單裡，測試一律先開選單再點。 */
const clickRowMenuItem = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  const trigger = screen.getByRole('button', { name: /更多操作/ });
  await user.click(trigger);
  await user.click(await screen.findByRole('menuitem', { name }));
  return trigger;
};

describe('商品庫存對話框語系', () => {
  it.each([
    ['zh-TW', '調整庫存', '請輸入進貨 / 增加件數：', '例如：10', '變動幅度：', '+3 件', '預估調整後現貨：', '10 件 → 13 件', '可售變為 11 件', '確認調整庫存'],
    ['en-US', 'Adjust stock', 'Enter received / added quantity:', 'Example: 10', 'Change:', '+3 units', 'Forecast on hand:', '10 units → 13 units', 'Available after adjustment: 11', 'Confirm adjustment'],
    ['ja-JP', '在庫を調整', '入庫 / 増加数を入力：', '例：10', '変動量：', '+3 個', '調整後の実在庫（予測）：', '10 個 → 13 個', '調整後の販売可能数：11', '在庫調整を確定'],
  ] as const)('localizes the nonzero forecast in %s without changing the preset request', async (locale, adjustStock, quantityLabel, example, changeLabel, delta, forecastLabel, onHand, available, confirm) => {
    const user = userEvent.setup();
    localStorage.setItem('storeweave.admin.locale', locale);
    renderPage();

    await screen.findByText(draft.name);
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(await screen.findByRole('menuitem', { name: adjustStock }));
    const quantity = await screen.findByLabelText(quantityLabel);
    expect(quantity).toHaveAttribute('placeholder', example);
    await user.type(quantity, '3');

    expect(screen.getByText(changeLabel)).toBeInTheDocument();
    expect(screen.getByText(delta)).toBeInTheDocument();
    expect(screen.getByText(forecastLabel)).toBeInTheDocument();
    expect(document.querySelector('.forecast-result-line strong')).toHaveTextContent(onHand);
    expect(screen.getByText(available)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: confirm }));
    await waitFor(() => expect(api.adjustInventory).toHaveBeenCalledWith({ productId: draft.id, delta: 3, reason: 'restock', reference: '廠商進貨入庫' }, expect.any(String)));
  });
});

describe('ProductsPage 編輯（工單 71）', () => {
  it('編輯表單帶入現值，只送出真的改過的欄位', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await user.click(screen.getByRole('button', { name: '編輯' }));

    const name = screen.getByLabelText('商品名稱') as HTMLInputElement;
    expect(name.value).toBe('藍色帆布鞋');
    expect((screen.getByLabelText('價格（cents）') as HTMLInputElement).value).toBe('120000');

    await user.clear(name);
    await user.type(name, '紅色帆布鞋');
    await user.click(screen.getByRole('button', { name: '儲存變更' }));
    await waitFor(() => expect(api.patchProduct).toHaveBeenCalledWith(draft.id, { name: '紅色帆布鞋' }, expect.any(String)));
  });

  it('沒有改動就不送出，也不會打出一個必然被拒的空更新', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await user.click(screen.getByRole('button', { name: '編輯' }));
    await user.click(screen.getByRole('button', { name: '儲存變更' }));
    expect(await screen.findByText(/沒有任何欄位被修改/)).toBeInTheDocument();
    expect(api.patchProduct).not.toHaveBeenCalled();
  });

  it('售價沿用建立表單的整數驗證', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await user.click(screen.getByRole('button', { name: '編輯' }));
    const price = screen.getByLabelText('價格（cents）');
    await user.clear(price);
    await user.type(price, '12.5');
    await user.click(screen.getByRole('button', { name: '儲存變更' }));
    expect(await screen.findByText(/非負整數/)).toBeInTheDocument();
    expect(api.patchProduct).not.toHaveBeenCalled();
  });

  it.each(['', '   ', '12.5', '1e3', '0x10', '-1'])('售價是 %o 這種輸入時擋下來，不會靜默改成別的數字', async (bad) => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await user.click(screen.getByRole('button', { name: '編輯' }));
    const price = screen.getByLabelText('價格（cents）');
    await user.clear(price);
    if (bad) await user.type(price, bad);
    await user.click(screen.getByRole('button', { name: '儲存變更' }));
    await waitFor(() => expect(screen.getByText(/非負整數/)).toBeInTheDocument());
    expect(api.patchProduct).not.toHaveBeenCalled();
  });

  it('改價與改描述會一起送出，清空描述送的是 null 而不是空字串', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await user.click(screen.getByRole('button', { name: '編輯' }));
    await user.clear(screen.getByLabelText('價格（cents）'));
    await user.type(screen.getByLabelText('價格（cents）'), '99000');
    await user.clear(screen.getByLabelText('商品描述'));
    await user.click(screen.getByRole('button', { name: '儲存變更' }));
    await waitFor(() => expect(api.patchProduct).toHaveBeenCalledWith(draft.id, { description: null, priceCents: 99000 }, expect.any(String)));
  });

  it('存檔成功會關掉表單並重新載入清單', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    vi.mocked(api.listProducts).mockClear();
    await user.click(screen.getByRole('button', { name: '編輯' }));
    await user.clear(screen.getByLabelText('商品名稱'));
    await user.type(screen.getByLabelText('商品名稱'), '紅色帆布鞋');
    await user.click(screen.getByRole('button', { name: '儲存變更' }));
    await waitFor(() => expect(api.listProducts).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByLabelText('商品名稱')).not.toBeInTheDocument());
  });

  it('儲存失敗時錯誤留在編輯表單上，表單不關', async () => {
    const user = userEvent.setup();
    vi.mocked(api.patchProduct).mockRejectedValue(new Error('目錄拒絕了這次更新'));
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await user.click(screen.getByRole('button', { name: '編輯' }));
    await user.clear(screen.getByLabelText('商品名稱'));
    await user.type(screen.getByLabelText('商品名稱'), '紅色帆布鞋');
    await user.click(screen.getByRole('button', { name: '儲存變更' }));
    expect(await screen.findByText(/目錄拒絕了這次更新/)).toBeInTheDocument();
    expect(screen.getByLabelText('商品名稱')).toBeInTheDocument();
  });

  it('誤上架的商品收得回 draft，封存是另一件事', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listProducts).mockResolvedValue({ items: [{ ...draft, status: 'active' }], total: 1 });
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await clickRowMenuItem(user, '下架回草稿');
    await waitFor(() => expect(api.patchProduct).toHaveBeenCalledWith(draft.id, { status: 'draft' }, expect.any(String)));
  });

  it('上下架失敗的錯誤不會跑到庫存調整那一格', async () => {
    const user = userEvent.setup();
    vi.mocked(api.patchProduct).mockRejectedValue(new Error('上架被拒'));
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await clickRowMenuItem(user, '上架');
    const banner = await screen.findByText(/上架被拒/);
    expect(banner.closest('td')).toBeNull();
  });

  it('上下架是具名的轉換，不是自由下拉', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await clickRowMenuItem(user, '上架');
    await waitFor(() => expect(api.patchProduct).toHaveBeenCalledWith(draft.id, { status: 'active' }, expect.any(String)));
  });

  it('已上架的給封存，已封存的給重新上架', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listProducts).mockResolvedValue({ items: [{ ...draft, status: 'active' }], total: 1 });
    const { unmount } = renderPage();
    await screen.findByText('藍色帆布鞋');
    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    expect(screen.queryByRole('menuitem', { name: '上架' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: '封存' }));
    await waitFor(() => expect(api.patchProduct).toHaveBeenCalledWith(draft.id, { status: 'archived' }, expect.any(String)));
    unmount();

    vi.mocked(api.patchProduct).mockClear();
    vi.mocked(api.listProducts).mockResolvedValue({ items: [{ ...draft, status: 'archived' }], total: 1 });
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await clickRowMenuItem(user, '重新上架');
    await waitFor(() => expect(api.patchProduct).toHaveBeenCalledWith(draft.id, { status: 'active' }, expect.any(String)));
  });

  it('說明改價不影響既有訂單，避免誤以為會回溯', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await user.click(screen.getByRole('button', { name: '編輯' }));
    expect(screen.getByText(/既有訂單的價格快照不受影響/)).toBeInTheDocument();
  });
});

describe('對話框的 Esc 退場', () => {
  it('編輯抽屜按 Esc 就關掉，不用移動滑鼠去找關閉鈕', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    const edit = screen.getByRole('button', { name: '編輯' });
    edit.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: /編輯商品/ })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /編輯商品/ })).not.toBeInTheDocument());
    expect(edit).toHaveFocus();
  });

  it('從列選單開啟的庫存調整對話框按 Esc 關掉並回到選單 trigger', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    const trigger = await clickRowMenuItem(user, '調整庫存');
    expect(await screen.findByRole('dialog', { name: /調整庫存/ })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /調整庫存/ })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});

describe('商品列表的操作密度', () => {
  it('每列只留主要動作，次要動作收在 ⋯ 選單裡', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');

    expect(screen.getByRole('button', { name: '編輯' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '上架' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    expect(await screen.findByRole('menuitem', { name: '上架' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '調整庫存' })).toBeInTheDocument();
  });

  it('⋯ 選單按 Esc 收起，不用點空白處', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    await screen.findByRole('menu');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('選單裡的狀態轉換照舊送出 patch', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    await user.click(await screen.findByRole('menuitem', { name: '上架' }));
    await waitFor(() => expect(api.patchProduct).toHaveBeenCalledWith(draft.id, { status: 'active' }, expect.any(String)));
  });
});

describe('Ticket 87 商品操作', () => {
  it('keeps a foreign-domain recovery invisible and untouched', async () => {
    const store = createAdminOperationStore();
    const foreign = { area: 'coupon', scope: 'coupon:create', kind: 'create', idempotencyKey: 'coupon-key', request: { code: 'WELCOME' } };
    const handle = store.begin(foreign)!;
    store.markUnknown(handle, new TypeError('coupon response lost'));
    renderPage({ store });

    await screen.findByText('藍色帆布鞋');
    expect(screen.queryByText('coupon response lost')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '以原操作重試' })).not.toBeInTheDocument();
    expect(store.find(foreign.scope)?.operation).toBe(foreign);
    expect(api.createProduct).not.toHaveBeenCalled();
    expect(api.patchProduct).not.toHaveBeenCalled();
    expect(api.adjustInventory).not.toHaveBeenCalled();
  });

  it('IN_PROGRESS 保留同一 key，確認成功後相同 payload 的下一次操作使用新 key', async () => {
    const user = userEvent.setup();
    vi.mocked(api.patchProduct).mockRejectedValueOnce(new ApiError('IDEMPOTENCY_IN_PROGRESS', 'still running', 409)).mockResolvedValue({ ...draft, status: 'active' });
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await clickRowMenuItem(user, '上架');
    await waitFor(() => expect(api.patchProduct).toHaveBeenCalledTimes(1));
    const first = vi.mocked(api.patchProduct).mock.calls[0];
    await user.click(screen.getByRole('button', { name: '以原操作重試' }));
    await waitFor(() => expect(api.patchProduct).toHaveBeenCalledTimes(2));
    const second = vi.mocked(api.patchProduct).mock.calls[1];
    expect(second[1]).toEqual(first[1]);
    expect(second[2]).toBe(first[2]);
    await clickRowMenuItem(user, '上架');
    await waitFor(() => expect(api.patchProduct).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.patchProduct).mock.calls[2][1]).toEqual(first[1]);
    expect(vi.mocked(api.patchProduct).mock.calls[2][2]).not.toBe(first[2]);
  });

  it('distinguishes an in-flight product operation from an unconfirmed outcome', async () => {
    const user = userEvent.setup();
    let rejectRequest!: (reason: unknown) => void;
    vi.mocked(api.patchProduct).mockImplementation(() => new Promise<Product>((_resolve, reject) => { rejectRequest = reject; }));
    renderPage();
    await screen.findByText(draft.name);
    await clickRowMenuItem(user, '上架');
    expect(await screen.findByText('商品操作處理中。')).toBeInTheDocument();

    rejectRequest(new TypeError('response lost'));
    expect(await screen.findByText('商品操作結果尚未確認。')).toBeInTheDocument();
    expect(screen.queryByText('操作尚未確認。')).not.toBeInTheDocument();
  });

  it('inventory failure remains an error instead of showing synthetic zero stock', async () => {
    vi.mocked(api.listInventory).mockRejectedValue(new Error('inventory offline'));
    renderPage();
    expect(await screen.findByText('inventory offline')).toBeInTheDocument();
    expect(screen.queryByText('可售 0')).not.toBeInTheDocument();
  });

  it('inventory error disables only fresh stock adjustment until its read retry succeeds', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listInventory).mockRejectedValueOnce(new Error('inventory offline'));
    renderPage();
    await screen.findByText('inventory offline');
    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    const adjustment = await screen.findByRole('menuitem', { name: '調整庫存' });
    expect(adjustment).toHaveAttribute('data-disabled', '');
    await user.click(adjustment);
    expect(screen.queryByRole('dialog', { name: /調整庫存/ })).not.toBeInTheDocument();
    expect(api.adjustInventory).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: '重新讀取' }));
    await waitFor(() => expect(api.listInventory).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    expect(await screen.findByRole('menuitem', { name: '調整庫存' })).not.toHaveAttribute('data-disabled');
  });

  it('initial product read failure shows only an explicit retry, then renders normal results after retry', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listProducts).mockRejectedValueOnce(new Error('catalog offline'));
    renderPage();
    expect(await screen.findByText('catalog offline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新讀取' })).toBeInTheDocument();
    expect(screen.queryByText('篩選結果總數')).not.toBeInTheDocument();
    expect(screen.queryByText('沒有找到符合條件的商品。')).not.toBeInTheDocument();
    expect(document.querySelector('.pagination-bar')).toBeNull();
    await user.click(screen.getByRole('button', { name: '重新讀取' }));
    expect(await screen.findByText('藍色帆布鞋')).toBeInTheDocument();
    expect(screen.getByText('篩選結果總數')).toBeInTheDocument();
  });

  it('a newly filtered product read failure cannot replace its error with empty/zero result UI', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    vi.mocked(api.listProducts).mockRejectedValueOnce(new Error('filtered catalog offline')).mockResolvedValue({ items: [draft], total: 1 });
    fireEvent.change(screen.getByPlaceholderText('搜尋商品名稱或 SKU'), { target: { value: 'failure' } });
    expect(await screen.findByText('filtered catalog offline')).toBeInTheDocument();
    expect(screen.queryByText('篩選結果總數')).not.toBeInTheDocument();
    expect(screen.queryByText('沒有找到符合條件的商品。')).not.toBeInTheDocument();
    expect(document.querySelector('.pagination-bar')).toBeNull();
    await user.click(screen.getByRole('button', { name: '重新讀取' }));
    expect(await screen.findByText('藍色帆布鞋')).toBeInTheDocument();
  });

  it('create unknown survives an unmount/remount and retries the immutable request/key', async () => {
    const user = userEvent.setup();
    const client = createAdminQueryClient();
    const store = createAdminOperationStore();
    vi.mocked(api.createProduct).mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(draft);
    const firstRender = renderPage({ client, store });
    await screen.findByText('藍色帆布鞋');
    window.dispatchEvent(new CustomEvent('admin:action:create-product', { cancelable: true }));
    await user.type(await screen.findByLabelText('SKU'), 'NEW-SKU');
    await user.type(screen.getByLabelText('名稱'), '重試商品');
    await user.type(screen.getByLabelText('價格（cents）'), '9');
    await user.click(screen.getByRole('button', { name: '建立' }));
    await waitFor(() => expect(api.createProduct).toHaveBeenCalledTimes(1));
    const first = vi.mocked(api.createProduct).mock.calls[0];
    firstRender.unmount();
    renderPage({ client, store });
    await user.click(await screen.findByRole('button', { name: '檢視原操作' }));
    expect(await screen.findByLabelText('SKU')).toHaveValue('NEW-SKU');
    expect(screen.getByLabelText('SKU')).toBeDisabled();
    expect(screen.getByRole('dialog', { name: /建立商品/ }).contains(document.activeElement)).toBe(true);
    await user.click(screen.getByRole('button', { name: '取消' }));
    await user.click(await screen.findByRole('button', { name: '以原操作重試' }));
    await waitFor(() => expect(api.createProduct).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.createProduct).mock.calls[1]).toEqual(first);
  });

  it('同一個建立抽屜可連續重試未知結果，最後仍用原 payload/key 完成', async () => {
    const user = userEvent.setup();
    vi.mocked(api.createProduct).mockRejectedValueOnce(new TypeError('offline one')).mockRejectedValueOnce(new TypeError('offline two')).mockResolvedValueOnce(draft);
    renderPage();
    await screen.findByText('藍色帆布鞋');
    window.dispatchEvent(new CustomEvent('admin:action:create-product', { cancelable: true }));
    await user.type(await screen.findByLabelText('SKU'), 'RETRY-SKU');
    await user.type(screen.getByLabelText('名稱'), '重試商品');
    await user.type(screen.getByLabelText('價格（cents）'), '9');
    await user.click(screen.getByRole('button', { name: '建立' }));
    await waitFor(() => expect(api.createProduct).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('SKU')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '建立' }));
    await waitFor(() => expect(api.createProduct).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: '建立' }));
    await waitFor(() => expect(api.createProduct).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.createProduct).mock.calls[1]).toEqual(vi.mocked(api.createProduct).mock.calls[0]);
    expect(vi.mocked(api.createProduct).mock.calls[2]).toEqual(vi.mocked(api.createProduct).mock.calls[0]);
  });

  it('definite rejection unlocks the same drawer, keeps its exact error, and gives the corrected operation a new key', async () => {
    const user = userEvent.setup();
    vi.mocked(api.createProduct).mockRejectedValueOnce(new TypeError('offline')).mockRejectedValueOnce(new ApiError('VALIDATION_ERROR', 'SKU 已存在', 400)).mockResolvedValueOnce(draft);
    renderPage();
    await screen.findByText('藍色帆布鞋');
    window.dispatchEvent(new CustomEvent('admin:action:create-product', { cancelable: true }));
    await user.type(await screen.findByLabelText('SKU'), 'DUP-SKU');
    await user.type(screen.getByLabelText('名稱'), '原商品');
    await user.type(screen.getByLabelText('價格（cents）'), '9');
    await user.click(screen.getByRole('button', { name: '建立' }));
    await waitFor(() => expect(api.createProduct).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: '建立' }));
    await waitFor(() => expect(screen.getByText('SKU 已存在')).toBeInTheDocument());
    expect(screen.getByLabelText('SKU')).toBeEnabled();
    await user.clear(screen.getByLabelText('SKU'));
    await user.type(screen.getByLabelText('SKU'), 'FIXED-SKU');
    await user.click(screen.getByRole('button', { name: '建立' }));
    await waitFor(() => expect(api.createProduct).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.createProduct).mock.calls[1][1]).toBe(vi.mocked(api.createProduct).mock.calls[0][1]);
    expect(vi.mocked(api.createProduct).mock.calls[2][1]).not.toBe(vi.mocked(api.createProduct).mock.calls[0][1]);
    expect(vi.mocked(api.createProduct).mock.calls[2][0]).toMatchObject({ sku: 'FIXED-SKU' });
  });

  it('ordinary create reopening restores the unresolved operation instead of silently starting a new one', async () => {
    const user = userEvent.setup();
    vi.mocked(api.createProduct).mockRejectedValueOnce(new TypeError('offline'));
    renderPage();
    await screen.findByText('藍色帆布鞋');
    window.dispatchEvent(new CustomEvent('admin:action:create-product', { cancelable: true }));
    await user.type(await screen.findByLabelText('SKU'), 'LOCKED-SKU');
    await user.type(screen.getByLabelText('名稱'), '鎖定商品');
    await user.type(screen.getByLabelText('價格（cents）'), '9');
    await user.click(screen.getByRole('button', { name: '建立' }));
    await waitFor(() => expect(api.createProduct).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: '取消' }));
    window.dispatchEvent(new CustomEvent('admin:action:create-product', { cancelable: true }));
    expect(await screen.findByLabelText('SKU')).toHaveValue('LOCKED-SKU');
    expect(screen.getByLabelText('SKU')).toBeDisabled();
  });

  it('edit recovery remains inspectable when filtering removed the target from the live list', async () => {
    const user = userEvent.setup();
    const store = createAdminOperationStore();
    const operation = { area: 'product', scope: 'product:edit:off-page', kind: 'edit' as const, productId: 'off-page', idempotencyKey: 'edit-key', request: { name: '儲存名稱' }, draft: { sku: 'OFF-SKU', currency: 'TWD', status: 'draft' as const, name: '儲存名稱', description: '原說明', priceCents: '7' } };
    const handle = store.begin(operation)!;
    store.markUnknown(handle, new TypeError('offline'));
    vi.mocked(api.listProducts).mockResolvedValue({ items: [], total: 0 });
    vi.mocked(api.listInventory).mockResolvedValue({ items: [], total: 0 });
    renderPage({ store });
    await user.click(await screen.findByRole('button', { name: '檢視原操作' }));
    expect(await screen.findByLabelText('商品名稱')).toHaveValue('儲存名稱');
    expect(screen.getByLabelText('商品名稱')).toBeDisabled();
    expect(screen.getByText('OFF-SKU')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /編輯商品/ }).contains(document.activeElement)).toBe(true);
  });

  it('stock recovery remains inspectable when filtering removed the target from the live list', async () => {
    const user = userEvent.setup();
    const store = createAdminOperationStore();
    const operation = { area: 'product', scope: 'product:stock:off-page', kind: 'stock' as const, productId: 'off-page', idempotencyKey: 'stock-key', request: { productId: 'off-page', delta: -3, reason: 'damage', reference: '運送破損報廢 - BOX-9' }, draft: { mode: 'deduct' as const, quantity: '3', reason: '運送破損報廢', customReason: '  BOX-9  ' } };
    const handle = store.begin(operation)!;
    store.markUnknown(handle, new TypeError('offline'));
    vi.mocked(api.listProducts).mockResolvedValue({ items: [], total: 0 });
    vi.mocked(api.listInventory).mockResolvedValue({ items: [], total: 0 });
    renderPage({ store });
    await user.click(await screen.findByRole('button', { name: '檢視原操作' }));
    expect(await screen.findByLabelText(/請輸入扣除/)).toHaveValue(3);
    expect(screen.getByLabelText(/請輸入扣除/)).toBeDisabled();
    expect(screen.getByPlaceholderText('補充說明或採購單號（選填）')).toHaveValue('  BOX-9  ');
    expect(screen.getByPlaceholderText('補充說明或採購單號（選填）')).toBeDisabled();
    expect(screen.getByRole('dialog', { name: /調整庫存/ }).contains(document.activeElement)).toBe(true);
  });

  it('recovered edit replays its saved patch/key even after the server already reflects that patch', async () => {
    const user = userEvent.setup();
    const store = createAdminOperationStore();
    const operation = { area: 'product', scope: `product:edit:${draft.id}`, kind: 'edit' as const, productId: draft.id, idempotencyKey: 'edit-replay-key', request: { name: '伺服器已套用' }, draft: { sku: draft.sku, currency: draft.currency, status: draft.status, name: '伺服器已套用', description: draft.description!, priceCents: String(draft.priceCents) } };
    const handle = store.begin(operation)!;
    store.markUnknown(handle, new TypeError('response lost'));
    vi.mocked(api.listProducts).mockResolvedValue({ items: [{ ...draft, name: '伺服器已套用' }], total: 1 });
    renderPage({ store });
    await screen.findByText('伺服器已套用');
    await user.click(screen.getByRole('button', { name: '檢視原操作' }));
    await user.click(screen.getByRole('button', { name: '儲存變更' }));
    await waitFor(() => expect(api.patchProduct).toHaveBeenCalledWith(draft.id, { name: '伺服器已套用' }, 'edit-replay-key'));
  });

  it('recovered set-stock replays its saved delta/key even when the refreshed level makes its draft delta zero', async () => {
    const user = userEvent.setup();
    const store = createAdminOperationStore();
    const operation = { area: 'product', scope: `product:stock:${draft.id}`, kind: 'stock' as const, productId: draft.id, idempotencyKey: 'stock-replay-key', request: { productId: draft.id, delta: 3, reason: 'correction', reference: '定期盤點更正' }, draft: { mode: 'set' as const, quantity: '13', reason: '定期盤點更正', customReason: '' } };
    const handle = store.begin(operation)!;
    store.markUnknown(handle, new TypeError('response lost'));
    vi.mocked(api.listInventory).mockResolvedValue({ items: [{ ...stock, onHand: 13, available: 11 }], total: 1 });
    renderPage({ store });
    await screen.findByText('藍色帆布鞋');
    await user.click(screen.getByRole('button', { name: '檢視原操作' }));
    await user.click(screen.getByRole('button', { name: '確認調整庫存' }));
    await waitFor(() => expect(api.adjustInventory).toHaveBeenCalledWith({ productId: draft.id, delta: 3, reason: 'correction', reference: '定期盤點更正' }, 'stock-replay-key'));
  });

  it('saved stock recovery remains replayable without fabricating a zero snapshot after an inventory error', async () => {
    const user = userEvent.setup();
    const store = createAdminOperationStore();
    const operation = { area: 'product', scope: `product:stock:${draft.id}`, kind: 'stock' as const, productId: draft.id, idempotencyKey: 'stock-no-snapshot-key', request: { productId: draft.id, delta: 3, reason: 'restock', reference: '廠商進貨入庫' }, draft: { mode: 'add' as const, quantity: '3', reason: '廠商進貨入庫', customReason: '' } };
    const handle = store.begin(operation)!;
    store.markUnknown(handle, new TypeError('response lost'));
    vi.mocked(api.listInventory).mockRejectedValue(new Error('inventory offline'));
    renderPage({ store });
    await screen.findByText('inventory offline');
    await user.click(screen.getByRole('button', { name: '檢視原操作' }));
    expect(await screen.findByText('庫存快照不可用，無法開始新的庫存調整。')).toBeInTheDocument();
    expect(screen.queryByText('現有庫存 (On Hand)')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '確認調整庫存' }));
    await waitFor(() => expect(api.adjustInventory).toHaveBeenCalledWith(operation.request, 'stock-no-snapshot-key'));
  });

  it('deduplicates concurrent observers with the same live query key', async () => {
    const client = createAdminQueryClient();
    const store = createAdminOperationStore();
    render(
      <QueryClientProvider client={client}>
        <AdminOperationProvider value={store}><I18nProvider><ProductsPage /><ProductsPage /></I18nProvider></AdminOperationProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(api.listProducts).toHaveBeenCalledTimes(1));
  });

  it('a late response for an earlier filter cannot replace the current filter result', async () => {
    let resolveInitial!: (value: { items: Product[]; total: number }) => void;
    const initial = new Promise<{ items: Product[]; total: number }>((resolve) => { resolveInitial = resolve; });
    let resolveFiltered!: (value: { items: Product[]; total: number }) => void;
    const filtered = new Promise<{ items: Product[]; total: number }>((resolve) => { resolveFiltered = resolve; });
    const matching = { ...draft, id: '22222222-2222-4222-8222-222222222222', sku: 'MATCH', name: '目前篩選結果' };
    vi.mocked(api.listProducts).mockImplementation((input) => input.q === 'new' ? filtered : initial);
    const user = userEvent.setup();
    renderPage();
    const search = await screen.findByPlaceholderText('搜尋商品名稱或 SKU');
    fireEvent.change(search, { target: { value: 'new' } });
    resolveFiltered({ items: [matching], total: 1 });
    expect(await screen.findByText('目前篩選結果')).toBeInTheDocument();
    resolveInitial({ items: [draft], total: 1 });
    await user.tab();
    expect(screen.getByText('目前篩選結果')).toBeInTheDocument();
    expect(screen.queryByText('藍色帆布鞋')).not.toBeInTheDocument();
  });
});

describe('建立商品抽屜', () => {
  const openCreateDrawer = () =>
    window.dispatchEvent(new CustomEvent('admin:action:create-product', { cancelable: true }));

  it('建立表單不再常駐佔版面，由頁首的建立商品開啟', async () => {
    renderPage();
    await screen.findByText('藍色帆布鞋');
    expect(screen.queryByLabelText('SKU')).not.toBeInTheDocument();

    openCreateDrawer();
    expect(await screen.findByRole('dialog', { name: /建立商品/ })).toBeInTheDocument();
  });

  it('抽屜裡填完欄位就能建立商品', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    openCreateDrawer();
    await screen.findByRole('dialog', { name: /建立商品/ });

    await user.type(screen.getByLabelText('SKU'), 'WD-NEW-01');
    await user.type(screen.getByLabelText('名稱'), '新商品');
    await user.type(screen.getByLabelText('價格（cents）'), '12000');
    await user.click(screen.getByRole('button', { name: '建立' }));

    await waitFor(() =>
      expect(api.createProduct).toHaveBeenCalledWith({
        sku: 'WD-NEW-01', name: '新商品', priceCents: 12000, currency: 'TWD', status: 'draft',
      }, expect.any(String)),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /建立商品/ })).not.toBeInTheDocument());
  });
});
