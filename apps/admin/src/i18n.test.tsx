import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { I18nProvider, useI18n } from './i18n';
import type { ReactNode } from 'react';

const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider>{children}</I18nProvider>;

function i18n() {
  return renderHook(() => useI18n(), { wrapper }).result.current;
}

describe('admin translator', () => {
  it('fills placeholders instead of leaving them on screen', () => {
    expect(i18n().t('paginationPage', { page: 2, total: 9 })).toBe('第 2 / 9 頁');
  });

  it('fills every placeholder of a multi-value message', () => {
    expect(i18n().t('paginationInfo', { start: 1, end: 20, total: 137 }))
      .toBe('顯示第 1–20 筆，共 137 筆篩選結果');
  });

  it('does not rescan a substituted value that looks like a placeholder', () => {
    expect(i18n().t('pricePreview', { value: '{value}' })).toBe('預覽：{value}');
  });

  it('fails loudly when a value is missing, rather than shipping the placeholder', () => {
    expect(() => i18n().t('paginationPage', { page: 2 })).toThrow(/total/);
  });

  it('leaves a message without placeholders alone', () => {
    expect(i18n().t('save')).toBe('儲存');
  });

  it('formats dates in the configured store time zone', () => {
    // 2026-09-09T16:30Z 在台北已是隔天。
    expect(i18n().formatDate('2026-09-09T16:30:00.000Z')).toContain('10');
  });
});
