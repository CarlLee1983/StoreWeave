type Tone = 'pass' | 'warn' | 'fail' | 'neutral';

function toneFor(value: string): Tone {
  const status = value.toLowerCase();
  if (/(paid|sent|deliver|pass|ok|healthy|connected|active)/.test(status)) return 'pass';
  if (/(fail|error|cancel|expired|dead|down)/.test(status)) return 'fail';
  if (/(pending|processing|retry|warn|degrad)/.test(status)) return 'warn';
  return 'neutral';
}

export function StatusBadge({ value }: { value: string }) {
  const tone = toneFor(value);
  return <span className={`status-pill status-pill--${tone}`}><StatusIcon tone={tone} />{value}</span>;
}

function StatusIcon({ tone }: { tone: Tone }) {
  if (tone === 'pass') return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m22 4-10 10.01-3-3"/></svg>;
  if (tone === 'warn') return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>;
  if (tone === 'fail') return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>;
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>;
}
