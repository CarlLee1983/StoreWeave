type Tone = 'pass' | 'warn' | 'fail' | 'neutral';

function toneFor(value: string): Tone {
  const status = value.toLowerCase();
  if (/(paid|sent|deliver|pass|ok|healthy|connected|active|running|issued|voided|completed|received|approved)/.test(status)) return 'pass';
  if (/(fail|error|cancel|expired|dead|down|rejected)/.test(status)) return 'fail';
  if (/(pending|awaiting|processing|retry|warn|degrad|requested|needs_information)/.test(status)) return 'warn';
  return 'neutral';
}

/**
 * label 讓呼叫端覆寫顯示文字：同一個 `active` 在商品是「上架中」，
 * 在帳號是「啟用中」——共用一組狀態字典會把商品的說法套到會員身上。
 * 色調一律由狀態值推導，覆寫的只有文字。
 */
export function StatusBadge({ value, label }: { value: string; label?: string }) {
  const { statusLabel } = useI18n();
  const tone = toneFor(value);
  return <span className={`status-pill status-pill--${tone}`}><StatusIcon tone={tone} />{label ?? statusLabel(value)}</span>;
}

function StatusIcon({ tone }: { tone: Tone }) {
  if (tone === 'pass') return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m22 4-10 10.01-3-3"/></svg>;
  if (tone === 'warn') return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>;
  if (tone === 'fail') return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>;
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>;
}
import { useI18n } from '../i18n';
