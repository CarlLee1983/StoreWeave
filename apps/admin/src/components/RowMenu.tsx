import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { useEscapeKey } from '../hooks/useEscapeKey';

export interface RowMenuItem {
  key: string;
  label: string;
  icon: IconName;
  onSelect: () => void;
  /** 破壞性動作（封存等）標紅，與一般動作分開讀。 */
  danger?: boolean;
}

/**
 * 表格列的次要動作選單。主要動作留在列上，其餘收進這裡：
 * 四顆按鈕平鋪會把列高撐成三倍，掃描一頁商品的成本比多點一下高得多。
 */
export function RowMenu({ items, label = '更多操作', disabled }: { items: RowMenuItem[]; label?: string; disabled?: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEscapeKey(() => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div className="row-menu" ref={wrapRef}>
      <button
        type="button"
        className="button button--quiet row-menu__trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more" />
      </button>
      {open ? (
        <div className="row-menu__popup" role="menu">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={`row-menu__item ${item.danger ? 'row-menu__item--danger' : ''}`}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              <Icon name={item.icon} /> {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
