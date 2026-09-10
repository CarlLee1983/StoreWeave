import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { OperatorsPage } from './OperatorsPage';
import { I18nProvider } from '../i18n';
import { api, type Operator } from '../api';
import { createAdminQueryClient } from '../query';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { listOperators: vi.fn(), createOperator: vi.fn(), setOperatorStatus: vi.fn() } };
});

const operator: Operator = { id: '11111111-1111-4111-8111-111111111111', email: 'ops@example.com', displayName: '王小華', role: 'staff', status: 'active', createdAt: '2026-08-24T08:00:00.000Z', lastLoginAt: '2026-09-01T00:00:00.000Z' };
const renderPage = (client = createAdminQueryClient()) => render(<QueryClientProvider client={client}><I18nProvider><OperatorsPage /></I18nProvider></QueryClientProvider>);

beforeEach(() => {
  vi.mocked(api.listOperators).mockReset().mockResolvedValue({ items: [operator], total: 1 });
  vi.mocked(api.createOperator).mockReset().mockResolvedValue({ ...operator, id: '22222222-2222-4222-8222-222222222222', email: 'new@example.com' });
  vi.mocked(api.setOperatorStatus).mockReset().mockResolvedValue({ ...operator, status: 'disabled' });
});

describe('OperatorsPage', () => {
  it('列出帳號的欄位與目前狀態', async () => {
    renderPage();
    expect(await screen.findByText(operator.email)).toBeInTheDocument();
    const row = screen.getByText(operator.email).closest('tr')!;
    expect(row).toHaveTextContent(operator.displayName);
    expect(row).toHaveTextContent(operator.role);
    expect(row).toHaveTextContent('啟用中');
  });

  it('頁首動作事件開出建立表單，送出後刷新清單', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(operator.email);
    expect(screen.queryByLabelText('電子郵件')).not.toBeInTheDocument();

    window.dispatchEvent(new CustomEvent('admin:action:create-operator', { cancelable: true }));
    expect(await screen.findByLabelText('電子郵件')).toBeInTheDocument();
    expect(document.getElementById('create-operator')).toBeInTheDocument();

    await user.type(screen.getByLabelText('電子郵件'), 'new@example.com');
    await user.type(screen.getByLabelText('顯示名稱'), '新帳號');
    await user.selectOptions(screen.getByLabelText('角色'), 'admin');
    await user.type(screen.getByLabelText('密碼'), 'super-secret-pass');
    await user.click(screen.getByRole('button', { name: '建立' }));

    await waitFor(() => expect(api.createOperator).toHaveBeenCalledWith({ email: 'new@example.com', password: 'super-secret-pass', displayName: '新帳號', role: 'admin' }, expect.any(String)));
    await waitFor(() => expect(api.listOperators).toHaveBeenCalledTimes(2));
  });

  it('切換帳號狀態送出冪等鍵並刷新清單', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: '停用' }));
    await waitFor(() => expect(api.setOperatorStatus).toHaveBeenCalledWith(operator.id, 'disabled', expect.any(String)));
    await waitFor(() => expect(api.listOperators).toHaveBeenCalledTimes(2));
  });

  it('清單讀取失敗時顯示錯誤橫幅', async () => {
    vi.mocked(api.listOperators).mockRejectedValue(new Error('read failed'));
    renderPage();
    expect(await screen.findByText(/read failed/)).toBeInTheDocument();
  });
});
