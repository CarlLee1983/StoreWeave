import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { ApiTokensPage } from './ApiTokensPage';
import { I18nProvider } from '../i18n';
import { api, type ApiToken, type IssuedApiToken } from '../api';
import { createAdminQueryClient } from '../query';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { listApiTokens: vi.fn(), issueApiToken: vi.fn(), revokeApiToken: vi.fn() } };
});

const token: ApiToken = { id: '11111111-1111-4111-8111-111111111111', name: 'mcp-warehouse', role: 'mcp', createdAt: '2026-08-24T08:00:00.000Z', expiresAt: '2026-09-23T08:00:00.000Z', lastUsedAt: null, revokedAt: null };
const issued: IssuedApiToken = { ...token, id: '22222222-2222-4222-8222-222222222222', name: 'mcp-new', secret: 'sk_live_abcdef123456' };
const renderPage = (client = createAdminQueryClient()) => render(<QueryClientProvider client={client}><I18nProvider><ApiTokensPage /></I18nProvider></QueryClientProvider>);

beforeEach(() => {
  vi.mocked(api.listApiTokens).mockReset().mockResolvedValue({ items: [token] });
  vi.mocked(api.issueApiToken).mockReset().mockResolvedValue(issued);
  vi.mocked(api.revokeApiToken).mockReset().mockResolvedValue({ ...token, revokedAt: '2026-08-25T00:00:00.000Z' });
});

describe('ApiTokensPage', () => {
  it('列出既有 token', async () => {
    renderPage();
    expect(await screen.findByText(token.name)).toBeInTheDocument();
    expect(screen.getByText(token.name).closest('tr')).toHaveTextContent(token.role);
  });

  it('簽發新 token 之後只顯示一次秘密，關閉後就不再出現', async () => {
    const user = userEvent.setup();
    renderPage();
    window.dispatchEvent(new CustomEvent('admin:action:issue-api-token', { cancelable: true }));
    await user.type(await screen.findByLabelText('名稱'), issued.name);
    await user.click(screen.getByRole('button', { name: '建立' }));
    await waitFor(() => expect(api.issueApiToken).toHaveBeenCalledWith({ name: issued.name, role: 'staff', ttlDays: 30 }, expect.any(String)));
    expect(await screen.findByText(issued.secret)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByText(issued.secret)).not.toBeInTheDocument();
  });

  it('撤銷 token', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '撤銷' }));
    await waitFor(() => expect(api.revokeApiToken).toHaveBeenCalledWith(token.name, expect.any(String)));
  });

  it('已撤銷的 token 沒有撤銷按鈕', async () => {
    vi.mocked(api.listApiTokens).mockResolvedValue({ items: [{ ...token, revokedAt: '2026-08-25T00:00:00.000Z' }] });
    renderPage();
    expect(await screen.findByText(token.name)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '撤銷' })).not.toBeInTheDocument();
  });

  it('讀取清單失敗時顯示錯誤橫幅', async () => {
    vi.mocked(api.listApiTokens).mockRejectedValue(new Error('network down'));
    renderPage();
    expect(await screen.findByText('network down')).toBeInTheDocument();
  });
});
