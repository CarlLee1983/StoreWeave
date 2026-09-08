import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { SystemPage } from './SystemPage';
import { I18nProvider } from '../i18n';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAdminQueryClient } from '../query';
import { api, type HealthReport } from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { healthDependencies: vi.fn(), listExtensions: vi.fn() } };
});

function renderPage() {
  return render(<QueryClientProvider client={createAdminQueryClient()}><I18nProvider><SystemPage /></I18nProvider></QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(api.healthDependencies).mockReset().mockResolvedValue({ status: 'ok', checks: [] });
  vi.mocked(api.listExtensions).mockReset().mockResolvedValue({ items: [] });
});

describe('SystemPage', () => {
  it('在沒有健康檢查或擴充套件時說明兩個空狀態', async () => {
    renderPage();

    expect(await screen.findByText('目前沒有相依性健康檢查結果。')).toBeInTheDocument();
    expect(await screen.findByText('目前沒有已安裝的擴充套件。')).toBeInTheDocument();
  });

  it('健康檢查載入失敗時顯示錯誤', async () => {
    vi.mocked(api.healthDependencies).mockRejectedValue(new Error('health unavailable'));
    renderPage();

    expect(await screen.findByText('health unavailable')).toBeInTheDocument();
  });

  it('擴充套件讀取失敗不遮蔽已成功的 degraded health', async () => {
    const degraded: HealthReport = {
      status: 'degraded',
      checks: [
        { name: 'postgres', status: 'pass', detail: 'connected' },
        { name: 'jobs', status: 'warn', detail: 'lagging' },
      ],
    };
    vi.mocked(api.healthDependencies).mockResolvedValue(degraded);
    vi.mocked(api.listExtensions).mockRejectedValue(new Error('extensions unavailable'));
    renderPage();

    expect(await screen.findByText('postgres')).toBeInTheDocument();
    expect(screen.getByText('lagging')).toBeInTheDocument();
    expect(await screen.findByText('extensions unavailable')).toBeInTheDocument();
    expect(screen.queryByText('目前沒有相依性健康檢查結果。')).not.toBeInTheDocument();
    expect(screen.queryByText('目前沒有已安裝的擴充套件。')).not.toBeInTheDocument();
  });
});
