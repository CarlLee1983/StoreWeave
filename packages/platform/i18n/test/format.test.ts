import { describe, expect, it } from 'vitest';
import { escapeHtml, safeUrlAttribute } from '../src/escape';
import { formatMoney } from '../src/money';
import { formatDate, formatDateTime, toIsoString } from '../src/time';

describe('escapeHtml', () => {
  it('escapes every character that can break out of markup', () => {
    expect(escapeHtml('<script>&"\'')).toBe('&lt;script&gt;&amp;&quot;&#39;');
  });

  it('escapes the ampersand first so entities are not double-decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('renders null and undefined as empty rather than as text', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('stringifies non-strings', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(false)).toBe('false');
  });
});

describe('formatMoney', () => {
  it('formats minor units as the locale currency', () => {
    expect(formatMoney(10_500, 'TWD', 'zh-TW')).toContain('105');
  });

  it('falls back to an escaped plain rendering when the locale or currency is unusable', () => {
    const output = formatMoney(10_500, 'not-a-currency', 'zh-TW');
    expect(output).toContain('105.00');
    expect(output).not.toContain('<');
  });

  it('does not lose the sign of a refund', () => {
    expect(formatMoney(-10_500, 'TWD', 'zh-TW')).toContain('105');
    expect(formatMoney(-10_500, 'TWD', 'zh-TW')).toMatch(/-|−|\(/);
  });
});

describe('time', () => {
  const instant = new Date('2026-09-09T16:30:00.000Z');

  it('serialises to ISO 8601 in UTC regardless of the host time zone', () => {
    expect(toIsoString(instant)).toBe('2026-09-09T16:30:00.000Z');
  });

  it('refuses to serialise an invalid date instead of writing "Invalid Date"', () => {
    expect(() => toIsoString(new Date('nope'))).toThrow(/date/i);
  });

  it('renders the configured time zone, not the host one', () => {
    const taipei = formatDateTime(instant, { locale: 'en-US', timeZone: 'Asia/Taipei' });
    const utc = formatDateTime(instant, { locale: 'en-US', timeZone: 'UTC' });
    expect(taipei).not.toBe(utc);
    // 台北是 UTC+8，所以同一刻在台北已經是隔天凌晨 0:30。
    expect(taipei).toContain('9/10');
    expect(utc).toContain('9/9');
  });

  it('formats a date-only rendering in the configured zone', () => {
    expect(formatDate(instant, { locale: 'en-US', timeZone: 'Asia/Taipei' })).toBe('9/10/26');
    expect(formatDate(instant, { locale: 'en-US', timeZone: 'UTC' })).toBe('9/9/26');
  });

  it('accepts an ISO string as well as a Date', () => {
    expect(formatDate('2026-09-09T16:30:00.000Z', { locale: 'en-US', timeZone: 'UTC' })).toBe('9/9/26');
  });

  it('falls back to the ISO rendering when the time zone is not recognised', () => {
    expect(formatDateTime(instant, { locale: 'en-US', timeZone: 'Mars/Olympus' })).toBe('2026-09-09T16:30:00.000Z');
  });

  it('refuses to format an unparseable value', () => {
    expect(() => formatDate('yesterday', { locale: 'en-US', timeZone: 'UTC' })).toThrow(/date/i);
  });
});

describe('time zone is not optional', () => {
  it('refuses to fall back to the host time zone when none is supplied', () => {
    expect(() => formatDate(new Date(), { locale: 'en-US' } as never)).toThrow(/time zone/i);
    expect(() => formatDateTime(new Date(), { locale: 'en-US', timeZone: '' })).toThrow(/time zone/i);
  });
});

describe('safeUrlAttribute', () => {
  it('passes through ordinary links', () => {
    expect(safeUrlAttribute('https://pay.example.com/redirect?a=1&b=2')).toBe('https://pay.example.com/redirect?a=1&amp;b=2');
    expect(safeUrlAttribute('/orders/1')).toBe('/orders/1');
    expect(safeUrlAttribute('mailto:support@example.com')).toBe('mailto:support@example.com');
  });

  it('drops schemes that execute', () => {
    for (const value of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:msgbox']) {
      expect(safeUrlAttribute(value)).toBe('');
    }
  });

  it('renders an absent value as an empty attribute', () => {
    expect(safeUrlAttribute(null)).toBe('');
    expect(safeUrlAttribute('   ')).toBe('');
  });
});
