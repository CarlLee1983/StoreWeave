import { describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DateField } from './DateField';
import { I18nProvider } from '../i18n';

const renderField = (props: Partial<Parameters<typeof DateField>[0]> = {}) => {
  const onChange = vi.fn();
  render(
    <I18nProvider>
      <DateField label="生日" value="" onChange={onChange} {...props} />
    </I18nProvider>,
  );
  return { onChange };
};

describe('DateField', () => {
  it('點日曆鈕開出選擇器，選一天就把 ISO 日期送回去', async () => {
    const user = userEvent.setup();
    const { onChange } = renderField({ value: '2026-08-10' });

    expect(screen.queryByRole('dialog', { name: /選擇日期/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /選擇日期/ }));

    const dialog = await screen.findByRole('dialog', { name: /選擇日期/ });
    await user.click(within(dialog).getByText('15'));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('2026-08-15'));
  });

  it('也能直接打字輸入，不強迫用滑鼠', async () => {
    const user = userEvent.setup();
    const { onChange } = renderField();

    await user.type(screen.getByLabelText('生日'), '2026-08-20');
    expect(onChange).toHaveBeenCalled();
  });

  it('日曆按 Esc 收起，不會改到值', async () => {
    const user = userEvent.setup();
    const { onChange } = renderField({ value: '2026-08-10' });

    const trigger = screen.getByRole('button', { name: /選擇日期/ });
    await user.click(trigger);
    await screen.findByRole('dialog', { name: /選擇日期/ });

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /選擇日期/ })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('點選欄位外會收起日曆', async () => {
    const user = userEvent.setup();
    renderField();

    await user.click(screen.getByRole('button', { name: /選擇日期/ }));
    await screen.findByRole('dialog', { name: /選擇日期/ });

    await user.click(document.body);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /選擇日期/ })).not.toBeInTheDocument());
  });
});
