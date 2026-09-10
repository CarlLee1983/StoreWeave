import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { InboxPage } from './InboxPage';
import { I18nProvider } from '../i18n';
import { api, type InboxNotification } from '../api';
import { createAdminQueryClient, inboxKeys } from '../query';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { listInbox: vi.fn(), markInboxRead: vi.fn() } };
});

const notification: InboxNotification = { id: '11111111-1111-4111-8111-111111111111', notificationId: 'n1', reference: 'order:1', templateId: 'order.paid', title: '訂單已付款', body: '你的訂單已完成付款', createdAt: '2026-08-24T08:00:00.000Z', readAt: null };
const renderPage = (client = createAdminQueryClient()) => render(<QueryClientProvider client={client}><I18nProvider><InboxPage /></I18nProvider></QueryClientProvider>);

beforeEach(() => {
  vi.mocked(api.listInbox).mockReset().mockResolvedValue({ items: [notification], total: 1, unread: 1 });
  vi.mocked(api.markInboxRead).mockReset().mockResolvedValue({ updated: 1, readAt: '2026-08-25T00:00:00.000Z' });
});

describe('InboxPage', () => {
  it('renders notifications addressed to this account', async () => {
    renderPage();
    expect(await screen.findByText(notification.title)).toBeInTheDocument();
    expect(screen.getByText(notification.body)).toBeInTheDocument();
  });

  it('toggling 只看未讀 refetches with unreadOnly true', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText(notification.title)).toBeInTheDocument();
    expect(api.listInbox).toHaveBeenCalledWith({ limit: 50, offset: 0, unreadOnly: false }, expect.any(AbortSignal));
    await user.click(screen.getByLabelText('只看未讀'));
    await waitFor(() => expect(api.listInbox).toHaveBeenLastCalledWith({ limit: 50, offset: 0, unreadOnly: true }, expect.any(AbortSignal)));
  });

  it('marking read calls the API and refetches the list', async () => {
    const client = createAdminQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const user = userEvent.setup();
    renderPage(client);
    await user.click(await screen.findByRole('button', { name: '標記已讀' }));
    await waitFor(() => expect(api.markInboxRead).toHaveBeenCalledWith([notification.id], expect.any(String)));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboxKeys.lists });
  });

  it('顯示清單載入失敗的 ErrorBanner', async () => {
    vi.mocked(api.listInbox).mockRejectedValue(new Error('network down'));
    renderPage();
    expect(await screen.findByText('network down')).toBeInTheDocument();
  });
});
