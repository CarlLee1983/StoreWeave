import { type ReactNode, useRef } from 'react';
import { Icon, type IconName } from './Icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';

export interface RowMenuItem {
  key: string;
  label: string;
  icon: IconName;
  onSelect: (trigger: HTMLButtonElement | null) => void;
  /** 破壞性動作（封存等）標紅，與一般動作分開讀。 */
  danger?: boolean;
  disabled?: boolean;
}

/**
 * 表格列的次要動作選單。主要動作留在列上，其餘收進這裡：
 * 四顆按鈕平鋪會把列高撐成三倍，掃描一頁商品的成本比多點一下高得多。
 */
export function RowMenu({ items, label = '更多操作', disabled }: { items: RowMenuItem[]; label?: string; disabled?: boolean }): ReactNode {
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button ref={triggerRef} type="button" className="button button--quiet row-menu__trigger" aria-label={label} disabled={disabled}>
          <Icon name="more" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item) => (
          <DropdownMenuItem key={item.key} disabled={item.disabled} className={item.danger ? 'ui-dropdown-menu-item--danger' : ''} onSelect={() => item.onSelect(triggerRef.current)}>
            <Icon name={item.icon} /> {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
