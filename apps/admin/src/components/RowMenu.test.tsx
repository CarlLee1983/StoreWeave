import { describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RowMenu } from './RowMenu';

describe('RowMenu', () => {
  it('以鍵盤選取動作後關閉並把焦點還給 trigger', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<RowMenu label="列動作" items={[
      { key: 'archive', label: '封存', icon: 'archive', onSelect: vi.fn() },
      { key: 'delete', label: '刪除', icon: 'trash', onSelect },
    ]} />);

    const trigger = screen.getByRole('button', { name: '列動作' });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('menuitem', { name: '封存' })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: '刪除' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('Esc 關閉選單並保留危險動作語意', async () => {
    const user = userEvent.setup();
    render(<RowMenu items={[{ key: 'delete', label: '刪除', icon: 'trash', danger: true, onSelect: vi.fn() }]} />);

    const trigger = screen.getByRole('button', { name: '更多操作' });
    await user.click(trigger);
    expect(await screen.findByRole('menuitem', { name: '刪除' })).toHaveClass('ui-dropdown-menu-item--danger');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
