import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from './LoginPage';
import { I18nProvider } from '../i18n';
import { api, type LoginResult } from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { login: vi.fn() } };
});

const user: LoginResult = { id: 'user-1', email: 'owner@storeweave.dev', displayName: 'Owner', role: 'admin', cartNotice: null };

function renderPage(onLoggedIn = vi.fn()) {
  return render(<I18nProvider><LoginPage onLoggedIn={onLoggedIn} /></I18nProvider>);
}

beforeEach(() => {
  vi.mocked(api.login).mockReset();
});

describe('LoginPage', () => {
  it('輸入帳密送出會呼叫 api.login 並回報成功結果', async () => {
    vi.mocked(api.login).mockResolvedValue(user);
    const onLoggedIn = vi.fn();

    renderPage(onLoggedIn);
    await userEvent.type(screen.getByLabelText('電子郵件'), 'owner@storeweave.dev');
    await userEvent.type(screen.getByLabelText('密碼'), 'correct-horse');
    await userEvent.click(screen.getByRole('button', { name: '登入' }));

    expect(api.login).toHaveBeenCalledWith('owner@storeweave.dev', 'correct-horse', undefined);
    await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledWith(user));
  });

  it('登入失敗顯示錯誤訊息', async () => {
    vi.mocked(api.login).mockRejectedValue(new Error('帳號或密碼錯誤'));

    renderPage();
    await userEvent.type(screen.getByLabelText('電子郵件'), 'owner@storeweave.dev');
    await userEvent.type(screen.getByLabelText('密碼'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: '登入' }));

    expect(await screen.findByText('帳號或密碼錯誤')).toBeInTheDocument();
  });

  it('送出過程中按鈕是 disabled', async () => {
    let resolveLogin: (value: LoginResult) => void = () => {};
    vi.mocked(api.login).mockReturnValue(new Promise((resolve) => { resolveLogin = resolve; }));

    renderPage();
    await userEvent.type(screen.getByLabelText('電子郵件'), 'owner@storeweave.dev');
    await userEvent.type(screen.getByLabelText('密碼'), 'correct-horse');
    await userEvent.click(screen.getByRole('button', { name: '登入' }));

    expect(screen.getByRole('button', { name: '登入中…' })).toBeDisabled();
    resolveLogin(user);
  });

  it('使用目前語系的登入展示文字', () => {
    localStorage.setItem('storeweave.admin.locale', 'en-US');
    renderPage();

    expect(screen.getByText('Quick-fill demo accounts')).toBeInTheDocument();
    expect(screen.getByText('Security-hardened session')).toBeInTheDocument();
    localStorage.removeItem('storeweave.admin.locale');
  });
});
