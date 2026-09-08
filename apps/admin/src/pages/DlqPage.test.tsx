import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { DlqPage } from './DlqPage';
import { I18nProvider } from '../i18n';
import { ApiError, api, type DeadJob } from '../api';
import { createAdminQueryClient, deadJobKeys, healthKeys } from '../query';
import { AdminOperationProvider, createAdminOperationStore } from '../admin-operations';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { listDeadJobs: vi.fn(), retryDeadJob: vi.fn() } };
});

const job: DeadJob = { id: 'job-1', type: 'demo-erp.resendOrder', attempts: 5, maxAttempts: 5, dedupeKey: null, lastError: 'upstream timeout', failedAt: '2026-08-20T10:00:00.000Z' };
const renderPage = (client = createAdminQueryClient()) => render(<QueryClientProvider client={client}><AdminOperationProvider value={createAdminOperationStore()}><I18nProvider><DlqPage /></I18nProvider></AdminOperationProvider></QueryClientProvider>);

beforeEach(() => {
  vi.mocked(api.listDeadJobs).mockReset().mockResolvedValue({ items: [job], total: 1 });
  vi.mocked(api.retryDeadJob).mockReset().mockResolvedValue({ jobId: job.id, status: 'pending' });
});

describe('DlqPage', () => {
  it('以固定 query input 讀取死信工作並顯示錯誤', async () => {
    renderPage();
    expect(await screen.findByText(job.type)).toBeInTheDocument();
    expect(screen.getByText(job.lastError!)).toBeInTheDocument();
    expect(api.listDeadJobs).toHaveBeenCalledWith({ limit: 50, offset: 0 }, expect.any(AbortSignal));
  });

  it('清單為空時保留既有空狀態', async () => {
    vi.mocked(api.listDeadJobs).mockResolvedValue({ items: [], total: 0 });
    renderPage();
    expect(await screen.findByText('目前沒有死信工作。')).toBeInTheDocument();
  });

  it('成功重送只失效 DLQ 和 health，並在重讀期間鎖住舊列', async () => {
    const client = createAdminQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    let release!: (result: { items: DeadJob[]; total: number }) => void;
    vi.mocked(api.listDeadJobs).mockImplementationOnce(() => Promise.resolve({ items: [job], total: 1 })).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const user = userEvent.setup();
    renderPage(client);
    const resend = await screen.findByRole('button', { name: '重送' });
    await user.click(resend);
    await waitFor(() => expect(api.retryDeadJob).toHaveBeenCalledWith(job.id, expect.any(String)));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: deadJobKeys.lists }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: healthKeys.dependencies });
    expect(resend).toBeDisabled();
    release({ items: [], total: 0 });
    expect(await screen.findByText('目前沒有死信工作。')).toBeInTheDocument();
  });

  it('未知重試沿用 key，明確拒絕後的下一次重送換 key', async () => {
    const user = userEvent.setup();
    vi.mocked(api.retryDeadJob).mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new ApiError('VALIDATION_ERROR', 'rejected', 422)).mockResolvedValueOnce({ jobId: job.id, status: 'pending' });
    renderPage();
    await user.click(await screen.findByRole('button', { name: '重送' }));
    await screen.findByRole('button', { name: '以原操作重試' });
    const first = vi.mocked(api.retryDeadJob).mock.calls[0][1];
    await user.click(screen.getByRole('button', { name: '以原操作重試' }));
    expect(await screen.findByText('rejected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重送' }));
    await waitFor(() => expect(api.retryDeadJob).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.retryDeadJob).mock.calls[1][1]).toBe(first);
    expect(vi.mocked(api.retryDeadJob).mock.calls[2][1]).not.toBe(first);
  });

  it('DLQ held-pending retry suppresses a second concrete click', async () => {
    let release!: (result: { jobId: string; status: string }) => void;
    vi.mocked(api.retryDeadJob).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const user = userEvent.setup();
    renderPage();
    const retry = await screen.findByRole('button', { name: '重送' });
    await user.dblClick(retry);
    expect(api.retryDeadJob).toHaveBeenCalledTimes(1);
    release({ jobId: job.id, status: 'pending' });
  });
});
