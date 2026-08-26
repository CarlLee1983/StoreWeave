import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContactInboxPage } from './ContactInboxPage';
import { I18nProvider } from '../i18n';
import { api, type ContactMessage } from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: { listContactMessages: vi.fn(), markContactMessageHandled: vi.fn() },
  };
});

const message: ContactMessage = {
  id: '22222222-2222-4222-8222-222222222222',
  customerId: null,
  name: '王小明',
  email: 'wang@example.com',
  subject: '想詢問退換貨',
  message: '請問買錯尺寸可以換貨嗎？',
  status: 'new',
  handledByActorId: null,
  handledAt: null,
  createdAt: '2026-08-24T08:00:00.000Z',
};

const renderPage = () => render(<I18nProvider><ContactInboxPage /></I18nProvider>);

beforeEach(() => {
  vi.mocked(api.listContactMessages).mockReset().mockResolvedValue({ items: [message], total: 1 });
  vi.mocked(api.markContactMessageHandled).mockReset().mockResolvedValue({ ...message, status: 'handled' });
});

describe('ContactInboxPage', () => {
  it('清單顯示姓名、信箱、主旨與狀態', async () => {
    renderPage();

    expect(await screen.findByText('王小明')).toBeInTheDocument();
    const row = screen.getByText('王小明').closest('tr')!;
    expect(row).toHaveTextContent('wang@example.com');
    expect(row).toHaveTextContent('想詢問退換貨');
    expect(row).toHaveTextContent('未處理');
  });

  it('可以依狀態篩選', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('王小明');

    await user.selectOptions(screen.getByLabelText('狀態'), 'handled');
    await waitFor(() => expect(api.listContactMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'handled' }),
    ));
  });

  it('點列展開詳情卡片可看到完整訊息內容', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('王小明');

    await user.click(screen.getByText('王小明'));

    expect(await screen.findByText('請問買錯尺寸可以換貨嗎？')).toBeInTheDocument();
  });

  it('未處理的訊息可以標記已處理，已處理的不再顯示這個動作', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('王小明');

    await user.click(screen.getByRole('button', { name: '標記已處理' }));

    await waitFor(() => expect(api.markContactMessageHandled).toHaveBeenCalledWith(message.id));
    expect(api.listContactMessages).toHaveBeenCalledTimes(2);
  });

  it('已處理的訊息不顯示標記已處理按鈕', async () => {
    vi.mocked(api.listContactMessages).mockResolvedValue({
      items: [{ ...message, status: 'handled', handledAt: '2026-08-25T00:00:00.000Z' }],
      total: 1,
    });
    renderPage();

    await screen.findByText('王小明');
    expect(screen.queryByRole('button', { name: '標記已處理' })).not.toBeInTheDocument();
  });

  it('標記已處理失敗時，即使列是收合的也看得到錯誤訊息', async () => {
    const user = userEvent.setup();
    vi.mocked(api.markContactMessageHandled).mockRejectedValue(new Error('already handled'));
    renderPage();
    await screen.findByText('王小明');

    await user.click(screen.getByRole('button', { name: '標記已處理' }));

    expect(await screen.findByText('already handled')).toBeInTheDocument();
  });

  it('沒有資料時顯示空狀態', async () => {
    vi.mocked(api.listContactMessages).mockResolvedValue({ items: [], total: 0 });
    renderPage();

    expect(await screen.findByText('目前沒有聯絡訊息。')).toBeInTheDocument();
  });
});
