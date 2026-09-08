import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RmaPage } from './RmaPage';
import { I18nProvider } from '../i18n';
import { api, type Rma } from '../api';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAdminQueryClient } from '../query';
import { AdminOperationProvider, createAdminOperationStore } from '../admin-operations';
import { rmaScope, type RmaOperation } from '../rma-operations';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { listRmas: vi.fn(), approveRma: vi.fn(), requestRmaInformation: vi.fn(), rejectRma: vi.fn(), receiveRma: vi.fn(), requestRmaRefund: vi.fn() } };
});

const line: Rma['lines'][number] = {
  id: '44444444-4444-4444-8444-444444444444', orderLineId: '55555555-5555-4555-8555-555555555555',
  productId: '66666666-6666-4666-8666-666666666666', sku: 'SKU-1', name: '藍色帆布鞋',
  quantity: 1, unitPriceCents: 120000, lineTotalCents: 120000, discountCents: 2000, disposition: null, discardReason: null,
};
const rma: Rma = {
  id: '77777777-7777-4777-8777-777777777777', orderId: '88888888-8888-4888-8888-888888888888',
  customerId: '99999999-9999-4999-8999-999999999999', status: 'requested', resolution: 'refund_and_reorder',
  reason: '尺寸不合', staffNote: null, refundId: null, receivedAt: null, completedAt: null,
  createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z', lines: [line],
};

beforeEach(() => {
  vi.mocked(api.listRmas).mockReset().mockResolvedValue({ items: [rma], total: 1 });
  vi.mocked(api.approveRma).mockReset().mockResolvedValue({ ...rma, status: 'approved' });
  vi.mocked(api.requestRmaInformation).mockReset().mockResolvedValue({ ...rma, status: 'needs_information' });
  vi.mocked(api.rejectRma).mockReset().mockResolvedValue({ ...rma, status: 'rejected' });
  vi.mocked(api.receiveRma).mockReset().mockResolvedValue({ ...rma, status: 'received' });
  vi.mocked(api.requestRmaRefund).mockReset().mockResolvedValue({ ...rma, status: 'refund_pending' });
});

const renderPage = (store = createAdminOperationStore()) => render(<QueryClientProvider client={createAdminQueryClient()}><AdminOperationProvider value={store}><I18nProvider><RmaPage /></I18nProvider></AdminOperationProvider></QueryClientProvider>);

describe('RmaPage', () => {
  it('keeps an unknown RMA command visible and retries its saved key', async () => {
    const user = userEvent.setup();
    vi.mocked(api.approveRma).mockRejectedValueOnce(new TypeError('response lost')).mockResolvedValueOnce({ ...rma, status: 'approved' });
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await user.click(screen.getByRole('button', { name: '核准' }));
    await screen.findByText('發生未知錯誤');
    const first = vi.mocked(api.approveRma).mock.calls[0];
    await user.click(screen.getByRole('button', { name: '以原操作重試' }));
    await waitFor(() => expect(api.approveRma).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.approveRma).mock.calls[1]).toEqual(first);
  });

  it('顯示案件的行項與申請原因，並可依狀態重新查詢', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('藍色帆布鞋')).toBeInTheDocument();
    expect(screen.getByText('尺寸不合')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('案件狀態'), 'approved');
    await waitFor(() => expect(api.listRmas).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'approved' }), expect.any(AbortSignal)));
  });

  it('可以用訂單 ID 把案件縮到一張單', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await user.type(screen.getByLabelText('訂單 ID'), rma.orderId);
    await user.click(screen.getByRole('button', { name: '查詢' }));
    await waitFor(() => expect(api.listRmas).toHaveBeenLastCalledWith(expect.objectContaining({ orderId: rma.orderId }), expect.any(AbortSignal)));
  });

  it('核准會把店員寫的備註一起送出，沒寫才不帶', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await user.click(screen.getByRole('button', { name: '核准' }));
    await waitFor(() => expect(api.approveRma).toHaveBeenCalledWith(rma.id, undefined, expect.any(String)));

    vi.mocked(api.approveRma).mockClear();
    await user.type(screen.getByLabelText('店員備註'), '已確認商品狀態');
    await user.click(screen.getByRole('button', { name: '核准' }));
    await waitFor(() => expect(api.approveRma).toHaveBeenCalledWith(rma.id, '已確認商品狀態', expect.any(String)));
  });

  it('動作按鈕跟著狀態機走，不讓店員送出不允許的轉換', async () => {
    vi.mocked(api.listRmas).mockResolvedValue({ items: [{ ...rma, status: 'completed' }], total: 1 });
    renderPage();
    expect(await screen.findByText('藍色帆布鞋')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '核准' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /更多操作/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '請求退款' })).not.toBeInTheDocument();
  });

  it('拒絕與補件都要求理由，沒填就不送出', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');

    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    await user.click(await screen.findByRole('menuitem', { name: '拒絕' }));
    const dialog = await screen.findByRole('dialog', { name: /拒絕/ });
    await user.click(within(dialog).getByRole('button', { name: '拒絕' }));
    expect(await screen.findByText(/請填寫原因/)).toBeInTheDocument();
    expect(api.rejectRma).not.toHaveBeenCalled();

    await user.type(within(dialog).getByRole('textbox'), '不符退貨條件');
    await user.click(within(dialog).getByRole('button', { name: '拒絕' }));
    await waitFor(() => expect(api.rejectRma).toHaveBeenCalledWith(rma.id, '不符退貨條件', expect.any(String)));
  });

  it('拒絕送出失敗時保留理由與對話框，不能讓客服重填上下文', async () => {
    const user = userEvent.setup();
    vi.mocked(api.rejectRma).mockRejectedValueOnce(new Error('temporary failure'));
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    await user.click(await screen.findByRole('menuitem', { name: '拒絕' }));
    const dialog = await screen.findByRole('dialog', { name: /拒絕/ });
    const reason = within(dialog).getByRole('textbox');
    await user.type(reason, '不符退貨條件');
    await user.click(within(dialog).getByRole('button', { name: '拒絕' }));

    expect(await within(dialog).findByText(/temporary failure/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /拒絕/ })).toBeInTheDocument();
    expect(reason).toHaveValue('不符退貨條件');
  });

  it('破壞性的拒絕不與核准並排，收在 ⋯ 選單裡', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    expect(screen.getByRole('button', { name: '核准' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '拒絕' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    expect(await screen.findByRole('menuitem', { name: '要求補件' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '拒絕' })).toBeInTheDocument();
  });

  it('理由對話框 Escape 後回到開啟它的列選單，不送出 command', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('藍色帆布鞋');
    const trigger = screen.getByRole('button', { name: /更多操作/ });
    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: '拒絕' }));
    await user.keyboard('{Escape}');

    await waitFor(() => expect(trigger).toHaveFocus());
    expect(api.rejectRma).not.toHaveBeenCalled();
  });

  it('收件時每一行都要選處置，選擇報廢就必須寫原因', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listRmas).mockResolvedValue({ items: [{ ...rma, status: 'approved' }], total: 1 });
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await user.selectOptions(screen.getByLabelText('藍色帆布鞋 處置'), 'discard');
    await user.click(screen.getByRole('button', { name: '登記收件' }));
    expect(await screen.findByText(/報廢必須填寫原因/)).toBeInTheDocument();
    expect(api.receiveRma).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('藍色帆布鞋 報廢原因'), '外觀已損毀');
    await user.click(screen.getByRole('button', { name: '登記收件' }));
    await waitFor(() => expect(api.receiveRma).toHaveBeenCalledWith(rma.id, [{ rmaLineId: line.id, disposition: 'discard', discardReason: '外觀已損毀' }], expect.any(String)));
  });

  it('收件 command pending 時連點只送一次，報廢選項與原因仍留在表單', async () => {
    const user = userEvent.setup();
    let resolve!: (value: Rma) => void;
    vi.mocked(api.listRmas).mockResolvedValue({ items: [{ ...rma, status: 'approved' }], total: 1 });
    vi.mocked(api.receiveRma).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    renderPage();
    await screen.findByText('藍色帆布鞋');
    await user.selectOptions(screen.getByLabelText('藍色帆布鞋 處置'), 'discard');
    await user.type(screen.getByLabelText('藍色帆布鞋 報廢原因'), '外觀已損毀');
    await user.dblClick(screen.getByRole('button', { name: '登記收件' }));

    expect(api.receiveRma).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('藍色帆布鞋 報廢原因')).toHaveValue('外觀已損毀');
    resolve({ ...rma, status: 'received' });
  });

  it('unknown-before-apply restores and locks the exact receive draft after remount, then retries its saved request and key', async () => {
    const user = userEvent.setup();
    const store = createAdminOperationStore();
    const operation: RmaOperation = {
      area: 'rma', scope: rmaScope(rma.id), kind: 'receive', rmaId: rma.id,
      resource: { orderId: rma.orderId, lines: [{ rmaLineId: line.id, sku: line.sku, name: line.name, quantity: line.quantity }] },
      request: { lines: [{ rmaLineId: line.id, disposition: 'discard', discardReason: '外觀已損毀' }] },
      draft: { lines: [{ rmaLineId: line.id, disposition: 'discard', discardReason: '  外觀已損毀  ' }] }, idempotencyKey: 'saved-rma-key',
    };
    const handle = store.begin(operation)!;
    store.markUnknown(handle, new TypeError('before apply'));
    vi.mocked(api.listRmas).mockResolvedValue({ items: [{ ...rma, status: 'approved' }], total: 1 });
    const mounted = renderPage(store);
    await screen.findByText('藍色帆布鞋');
    expect(screen.getByLabelText('藍色帆布鞋 處置')).toHaveValue('discard');
    expect(screen.getByLabelText('藍色帆布鞋 處置')).toBeDisabled();
    expect(screen.getByLabelText('藍色帆布鞋 報廢原因')).toHaveValue('  外觀已損毀  ');
    expect(screen.getByLabelText('藍色帆布鞋 報廢原因')).toHaveAttribute('readonly');
    mounted.unmount();
    renderPage(store);
    await screen.findByText('藍色帆布鞋');
    expect(screen.getByLabelText('藍色帆布鞋 報廢原因')).toHaveValue('  外觀已損毀  ');
    await user.click(screen.getByRole('button', { name: '以原操作重試' }));
    await waitFor(() => expect(api.receiveRma).toHaveBeenCalledWith(rma.id, operation.request.lines, 'saved-rma-key'));
  });

  it('keeps a lost-response recovery visible when an approved filter returns no rows', async () => {
    const store = createAdminOperationStore();
    const operation: RmaOperation = {
      area: 'rma', scope: rmaScope(rma.id), kind: 'receive', rmaId: rma.id,
      resource: { orderId: rma.orderId, lines: [{ rmaLineId: line.id, sku: line.sku, name: line.name, quantity: line.quantity }] },
      request: { lines: [{ rmaLineId: line.id, disposition: 'restock' }] },
      draft: { lines: [{ rmaLineId: line.id, disposition: 'restock', discardReason: '' }] }, idempotencyKey: 'response-lost-key',
    };
    const handle = store.begin(operation)!;
    store.markUnknown(handle, new TypeError('response lost'));
    vi.mocked(api.listRmas).mockResolvedValue({ items: [], total: 0 });
    renderPage(store);
    expect(await screen.findByText('以原操作重試')).toBeInTheDocument();
    expect(screen.getByText('藍色帆布鞋 · SKU-1 × 1')).toBeInTheDocument();
  });
});
