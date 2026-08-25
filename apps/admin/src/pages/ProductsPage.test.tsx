import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProductsPage } from './ProductsPage';
import { I18nProvider } from '../i18n';
import { api, type Product, type Stock } from '../api';

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
  vi.mocked(api.listProducts).mockReset().mockResolvedValue({ items: [draft], total: 1 });
  vi.mocked(api.listInventory).mockReset().mockResolvedValue({ items: [stock], total: 1 });
  vi.mocked(api.createProduct).mockReset().mockResolvedValue(draft);
  vi.mocked(api.patchProduct).mockReset().mockImplementation(async (_id, body) => ({ ...draft, ...body }));
  vi.mocked(api.adjustInventory).mockReset().mockResolvedValue(stock);
});

const renderPage = () => render(<I18nProvider><ProductsPage /></I18nProvider>);

/** 次要動作收在每列的 ⋯ 選單裡，測試一律先開選單再點。 */
const clickRowMenuItem = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(screen.getByRole('button', { name: /更多操作/ }));
  await user.click(await screen.findByRole('menuitem', { name }));
};

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
    await waitFor(() => expect(api.patchProduct).toHaveBeenCalledWith(draft.id, { name: '紅色帆布鞋' }));
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
    await waitFor(() => expect(api.patchProduct).toHaveBeenCalledWith(draft.id, { description: null, priceCents: 99000 }));
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
    await waitFor(() => expect(api.patchProduct).toHaveBeenCalledWith(draft.id, { status: 'draft' }));
  });

  it('上下架失敗的錯誤不會跑到庫存調整那一格', async () => {
    const user = userEvent.setup();
    vi.mocked(api.patchProduct).mockRejectedValue(new Error('上架被拒'));
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await clickRowMenuItem(user, '上架');
    const banner = await screen.findByText(/上架被拒/);
    expect(banner.closest('td')).toBe(screen.getByRole('button', { name: /更多操作/ }).closest('td'));
  });

  it('上下架是具名的轉換，不是自由下拉', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await clickRowMenuItem(user, '上架');
    await waitFor(() => expect(api.patchProduct).toHaveBeenCalledWith(draft.id, { status: 'active' }));
  });

  it('已上架的給封存，已封存的給重新上架', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listProducts).mockResolvedValue({ items: [{ ...draft, status: 'active' }], total: 1 });
    const { unmount } = renderPage();
    await screen.findByText('藍色帆布鞋');
    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    expect(screen.queryByRole('menuitem', { name: '上架' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: '封存' }));
    await waitFor(() => expect(api.patchProduct).toHaveBeenCalledWith(draft.id, { status: 'archived' }));
    unmount();

    vi.mocked(api.patchProduct).mockClear();
    vi.mocked(api.listProducts).mockResolvedValue({ items: [{ ...draft, status: 'archived' }], total: 1 });
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await clickRowMenuItem(user, '重新上架');
    await waitFor(() => expect(api.patchProduct).toHaveBeenCalledWith(draft.id, { status: 'active' }));
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
    await user.click(screen.getByRole('button', { name: '編輯' }));
    expect(await screen.findByRole('dialog', { name: /編輯商品/ })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /編輯商品/ })).not.toBeInTheDocument());
  });

  it('庫存調整對話框按 Esc 就關掉', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await clickRowMenuItem(user, '調整庫存');
    expect(await screen.findByRole('dialog', { name: /調整庫存/ })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /調整庫存/ })).not.toBeInTheDocument());
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
    await waitFor(() => expect(api.patchProduct).toHaveBeenCalledWith(draft.id, { status: 'active' }));
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
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /建立商品/ })).not.toBeInTheDocument());
  });
});
