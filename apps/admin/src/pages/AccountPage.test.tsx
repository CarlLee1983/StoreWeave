import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { AccountPage } from './AccountPage';
import { I18nProvider } from '../i18n';
import { api, type MfaStatus } from '../api';
import { createAdminQueryClient } from '../query';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      changePassword: vi.fn(),
      changeEmail: vi.fn(),
      resendVerification: vi.fn(),
      revokeOtherSessions: vi.fn(),
      mfaStatus: vi.fn(),
      mfaEnroll: vi.fn(),
      mfaConfirm: vi.fn(),
      mfaRecoveryCodes: vi.fn(),
      mfaDisable: vi.fn(),
    },
  };
});

const notEnrolled: MfaStatus = { enrolled: false, confirmed: false, recoveryCodesRemaining: 0 };

function renderPage(client = createAdminQueryClient()) {
  return render(<QueryClientProvider client={client}><I18nProvider><AccountPage /></I18nProvider></QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(api.changePassword).mockReset();
  vi.mocked(api.changeEmail).mockReset();
  vi.mocked(api.resendVerification).mockReset();
  vi.mocked(api.revokeOtherSessions).mockReset();
  vi.mocked(api.mfaStatus).mockReset().mockResolvedValue(notEnrolled);
  vi.mocked(api.mfaEnroll).mockReset();
  vi.mocked(api.mfaConfirm).mockReset();
  vi.mocked(api.mfaRecoveryCodes).mockReset();
  vi.mocked(api.mfaDisable).mockReset();
});

describe('AccountPage', () => {
  it('變更密碼會呼叫 api.changePassword 並顯示成功狀態', async () => {
    vi.mocked(api.changePassword).mockResolvedValue({ changed: true });
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getAllByLabelText('目前密碼')[0], 'current-password');
    await user.type(screen.getByLabelText('新密碼'), 'a-brand-new-password');
    await user.click(screen.getByRole('button', { name: '變更密碼' }));

    expect(api.changePassword).toHaveBeenCalledWith({ currentPassword: 'current-password', newPassword: 'a-brand-new-password' });
    expect(await screen.findAllByRole('status')).not.toHaveLength(0);
  });

  it('變更電子郵件會呼叫 api.changeEmail 並顯示成功狀態', async () => {
    vi.mocked(api.changeEmail).mockResolvedValue({ accepted: true });
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getAllByLabelText('目前密碼')[1], 'current-password');
    await user.type(screen.getByLabelText('新的電子郵件'), 'next@example.com');
    await user.click(screen.getByRole('button', { name: '變更電子郵件' }));

    expect(api.changeEmail).toHaveBeenCalledWith({ currentPassword: 'current-password', newEmail: 'next@example.com' });
    expect(await screen.findAllByRole('status')).not.toHaveLength(0);
  });

  it('登出其他裝置會呼叫 api.revokeOtherSessions', async () => {
    vi.mocked(api.revokeOtherSessions).mockResolvedValue({ accepted: true });
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: '登出其他裝置' }));

    expect(api.revokeOtherSessions).toHaveBeenCalled();
    expect(await screen.findAllByRole('status')).not.toHaveLength(0);
  });

  it('MFA 開始設定並完成確認後只顯示一次復原碼', async () => {
    vi.mocked(api.mfaEnroll).mockResolvedValue({ secret: 'SECRETKEY', uri: 'otpauth://totp/x' });
    vi.mocked(api.mfaConfirm).mockResolvedValue({ recoveryCodes: ['code-1', 'code-2'] });
    const client = createAdminQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const user = userEvent.setup();
    renderPage(client);

    await user.click(await screen.findByRole('button', { name: '開始設定' }));
    expect(await screen.findByText('SECRETKEY')).toBeInTheDocument();

    await user.type(screen.getByLabelText('驗證碼'), '123456');
    await user.click(screen.getByRole('button', { name: '完成設定' }));

    expect(api.mfaConfirm).toHaveBeenCalledWith('123456');
    expect(await screen.findByText('code-1')).toBeInTheDocument();
    expect(screen.getByText('code-2')).toBeInTheDocument();
    expect(screen.queryByText('SECRETKEY')).not.toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['account', 'mfa'] });
  });

  it('失敗的變更密碼顯示 ErrorBanner', async () => {
    vi.mocked(api.changePassword).mockRejectedValue(new Error('密碼不符合規則'));
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getAllByLabelText('目前密碼')[0], 'current-password');
    await user.type(screen.getByLabelText('新密碼'), 'a-brand-new-password');
    await user.click(screen.getByRole('button', { name: '變更密碼' }));

    expect(await screen.findByText('密碼不符合規則')).toBeInTheDocument();
  });
});
