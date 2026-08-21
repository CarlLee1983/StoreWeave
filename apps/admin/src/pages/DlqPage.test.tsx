import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DlqPage } from './DlqPage';
import { I18nProvider } from '../i18n';
import { api, type DeadJob } from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { listDeadJobs: vi.fn(), retryDeadJob: vi.fn() } };
});

const job: DeadJob = {
  id: 'job-1',
  type: 'demo-erp.resendOrder',
  attempts: 5,
  maxAttempts: 5,
  dedupeKey: null,
  lastError: 'upstream timeout',
  failedAt: '2026-08-20T10:00:00.000Z',
};

function renderPage(onChanged = vi.fn()) {
  return render(<I18nProvider><DlqPage onChanged={onChanged} /></I18nProvider>);
}

beforeEach(() => {
  vi.mocked(api.listDeadJobs).mockReset();
  vi.mocked(api.retryDeadJob).mockReset();
});

describe('DlqPage', () => {
  it('顯示死信工作與最後錯誤', async () => {
    vi.mocked(api.listDeadJobs).mockResolvedValue({ items: [job], total: 1 });

    renderPage();

    expect(await screen.findByText('demo-erp.resendOrder')).toBeInTheDocument();
    expect(screen.getByText('upstream timeout')).toBeInTheDocument();
  });

  it('按下重送會呼叫 api.retryDeadJob 並重新載入清單', async () => {
    vi.mocked(api.listDeadJobs)
      .mockResolvedValueOnce({ items: [job], total: 1 })
      .mockResolvedValueOnce({ items: [], total: 0 });
    vi.mocked(api.retryDeadJob).mockResolvedValue({ jobId: job.id, status: 'pending' });
    const onChanged = vi.fn();

    renderPage(onChanged);
    await screen.findByText('demo-erp.resendOrder');

    await userEvent.click(screen.getByRole('button', { name: '重送' }));

    await waitFor(() => expect(api.retryDeadJob).toHaveBeenCalledWith(job.id));
    await waitFor(() => expect(api.listDeadJobs).toHaveBeenCalledTimes(2));
    expect(onChanged).toHaveBeenCalled();
  });

  it('清單為空時顯示空狀態', async () => {
    vi.mocked(api.listDeadJobs).mockResolvedValue({ items: [], total: 0 });

    renderPage();

    expect(await screen.findByText('目前沒有死信工作。')).toBeInTheDocument();
  });
});
