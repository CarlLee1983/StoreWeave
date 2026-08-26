import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { I18nProvider } from './i18n';
import 'react-day-picker/style.css';
import './styles.css';
import './enhancements.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 掛載點');
}

createRoot(container).render(
  <StrictMode>
    <I18nProvider><App /></I18nProvider>
  </StrictMode>,
);
