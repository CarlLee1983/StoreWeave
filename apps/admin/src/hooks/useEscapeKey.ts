import { useEffect, useRef } from 'react';

/**
 * Esc 關閉對話框（DESIGN.md §1.4：每個對話框都要有 quick escape）。
 * 綁在 window 上而非對話框節點，焦點停在輸入框或還沒移進對話框時也要能退場。
 */
export function useEscapeKey(onEscape: () => void): void {
  const handler = useRef(onEscape);
  handler.current = onEscape;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handler.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
