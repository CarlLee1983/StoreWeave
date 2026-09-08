import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReasonDialog } from './ReasonDialog';

const renderDialog = () => {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  const Harness = () => {
    const [open, setOpen] = useState(true);
    return open ? <ReasonDialog title="拒絕退貨" description="請填寫原因" confirmLabel="拒絕" danger onClose={() => { onClose(); setOpen(false); }} onConfirm={onConfirm} /> : null;
  };
  render(<Harness />);
  return { onClose, onConfirm };
};

describe('ReasonDialog', () => {
  it('自動聚焦理由欄、trim 後才送出，空白理由會顯示錯誤', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    const reason = await screen.findByRole('textbox', { name: '拒絕退貨' });
    expect(reason).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: '關閉' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: '拒絕' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '關閉' })).toHaveFocus();
    reason.focus();

    await user.type(reason, '   ');
    await user.click(screen.getByRole('button', { name: '拒絕' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText('請填寫原因後再送出。')).toBeInTheDocument();

    await user.clear(reason);
    await user.type(reason, ' 不符合退貨條件 ');
    await user.click(screen.getByRole('button', { name: '拒絕' }));
    expect(onConfirm).toHaveBeenCalledWith('不符合退貨條件');
  });

  it('Esc 關閉、不送出並恢復原焦點', async () => {
    const user = userEvent.setup();
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const { onClose, onConfirm } = renderDialog();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });

  it('取消只關閉，不送出', async () => {
    const user = userEvent.setup();
    const { onClose, onConfirm } = renderDialog();

    await user.click(await screen.findByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('唯讀復原對話框聚焦可用的取消控制', async () => {
    render(<ReasonDialog title="拒絕退貨" confirmLabel="拒絕" initialReason="原理由" readOnly onClose={() => undefined} onConfirm={() => undefined} />);
    expect(await screen.findByRole('button', { name: '取消' })).toHaveFocus();
    expect(screen.getByRole('textbox', { name: '拒絕退貨' })).toHaveAttribute('readonly');
  });

  it('在同一對話框從 pending 變成 unknown 時聚焦新出現的重試', async () => {
    const retryRef = { current: null as HTMLButtonElement | null };
    const Harness = () => {
      const [ready, setReady] = useState(false);
      useEffect(() => { setReady(true); }, []);
      return <ReasonDialog title="拒絕退貨" confirmLabel="拒絕" initialReason="原理由" readOnly recoveryFocusRef={retryRef} recoveryReady={ready} recoveryAction={<button ref={retryRef} type="button" disabled={!ready}>以原操作重試</button>} onClose={() => undefined} onConfirm={() => undefined} />;
    };
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole('button', { name: '以原操作重試' })).toHaveFocus());
  });
});
