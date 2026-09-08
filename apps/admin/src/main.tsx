import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { I18nProvider } from './i18n';
import { createAdminQueryClient } from './query';
import { createAdminOperationStore, AdminOperationProvider } from './admin-operations';
import 'react-day-picker/style.css';
import './styles.css';
import './enhancements.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 掛載點');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={createAdminQueryClient()}>
      <AdminOperationProvider value={createAdminOperationStore()}>
        <I18nProvider><App /></I18nProvider>
      </AdminOperationProvider>
    </QueryClientProvider>
  </StrictMode>,
);
