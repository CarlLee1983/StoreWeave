import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { ContactInboxPage } from './ContactInboxPage';
import { I18nProvider } from '../i18n';
import { ApiError, api, type ContactMessage } from '../api';
import { contactMessageKeys, createAdminQueryClient } from '../query';
import { AdminOperationProvider, createAdminOperationStore } from '../admin-operations';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { listContactMessages: vi.fn(), markContactMessageHandled: vi.fn() } };
});

const message: ContactMessage = { id: '22222222-2222-4222-8222-222222222222', customerId: null, name: '王小明', email: 'wang@example.com', subject: '想詢問退換貨', message: '請問買錯尺寸可以換貨嗎？', status: 'new', handledByActorId: null, handledAt: null, createdAt: '2026-08-24T08:00:00.000Z' };
const renderPage = (client = createAdminQueryClient(), store = createAdminOperationStore()) => render(<QueryClientProvider client={client}><AdminOperationProvider value={store}><I18nProvider><ContactInboxPage /></I18nProvider></AdminOperationProvider></QueryClientProvider>);

beforeEach(() => {
  vi.mocked(api.listContactMessages).mockReset().mockResolvedValue({ items: [message], total: 1 });
  vi.mocked(api.markContactMessageHandled).mockReset().mockResolvedValue({ ...message, status: 'handled' });
});

describe('ContactInboxPage', () => {
  it('保留新訊息的原始主旨與精確未處理狀態', async () => {
    renderPage();
    expect(await screen.findByText(message.name)).toBeInTheDocument();
    const row = screen.getByText(message.name).closest('tr')!;
    expect(row).toHaveTextContent(message.subject);
    expect(row).toHaveTextContent('未處理');
  });

  it('保留清單欄位、主旨、狀態與已處理訊息沒有操作按鈕的行為', async () => {
    vi.mocked(api.listContactMessages).mockResolvedValue({ items: [{ ...message, status: 'handled', handledAt: '2026-08-25T00:00:00.000Z' }], total: 1 });
    renderPage();
    expect(await screen.findByText(message.name)).toBeInTheDocument();
    expect(screen.getByText(message.name).closest('tr')).toHaveTextContent(message.email);
    expect(screen.getByText(message.name).closest('tr')).toHaveTextContent(message.subject);
    expect(screen.getByText(message.name).closest('tr')).toHaveTextContent('已處理');
    expect(screen.queryByRole('button', { name: '標記已處理' })).not.toBeInTheDocument();
  });

  it('uses normalized filters, signal, and keeps the detail expansion local', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText(message.name)).toBeInTheDocument();
    expect(api.listContactMessages).toHaveBeenCalledWith({ limit: 100, offset: 0 }, expect.any(AbortSignal));
    await user.selectOptions(screen.getByLabelText('狀態'), 'handled');
    await waitFor(() => expect(api.listContactMessages).toHaveBeenLastCalledWith({ status: 'handled', limit: 100, offset: 0 }, expect.any(AbortSignal)));
    await user.click(screen.getByText(message.name));
    expect(await screen.findByText(message.message)).toBeInTheDocument();
  });

  it('marks handled with a key and only invalidates the contact-list family', async () => {
    const client = createAdminQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const user = userEvent.setup();
    renderPage(client);
    await user.click(await screen.findByRole('button', { name: '標記已處理' }));
    await waitFor(() => expect(api.markContactMessageHandled).toHaveBeenCalledWith(message.id, expect.any(String)));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: contactMessageKeys.lists });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('unknown recovery retains its preview and key; terminal retry releases a new legal command', async () => {
    const user = userEvent.setup();
    vi.mocked(api.markContactMessageHandled).mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new ApiError('VALIDATION_ERROR', 'already handled', 422)).mockResolvedValueOnce({ ...message, status: 'handled' });
    renderPage();
    await user.click(await screen.findByRole('button', { name: '標記已處理' }));
    await user.click(await screen.findByRole('button', { name: '以原操作重試' }));
    expect(await screen.findByText('already handled')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '標記已處理' }));
    await waitFor(() => expect(api.markContactMessageHandled).toHaveBeenCalledTimes(3));
    const keys = vi.mocked(api.markContactMessageHandled).mock.calls.map((call) => call[1]);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('空結果仍顯示既有空狀態', async () => {
    vi.mocked(api.listContactMessages).mockResolvedValue({ items: [], total: 0 });
    renderPage();
    expect(await screen.findByText('目前沒有聯絡訊息。')).toBeInTheDocument();
  });

  it('contact held-pending mark-handled suppresses a second concrete click', async () => {
    let release!: (result: ContactMessage) => void;
    vi.mocked(api.markContactMessageHandled).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const user = userEvent.setup();
    renderPage();
    const markHandled = await screen.findByRole('button', { name: '標記已處理' });
    await user.dblClick(markHandled);
    expect(api.markContactMessageHandled).toHaveBeenCalledTimes(1);
    release({ ...message, status: 'handled' });
  });
});
