import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * 空清單的統一樣貌。各頁原本各自寫一句裸文字（有的頁乾脆什麼都不放，
 * 只剩一排孤零零的表頭），看起來像沒做完而不是「這裡本來就還沒有資料」。
 */
export function EmptyState({
  icon = 'box',
  title,
  hint,
  action,
}: {
  icon?: IconName;
  title: string;
  hint?: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="empty-state">
      <span className="empty-state__icon"><Icon name={icon} /></span>
      <p className="empty-state__title">{title}</p>
      {hint ? <p className="empty-state__hint">{hint}</p> : null}
      {action}
    </div>
  );
}
