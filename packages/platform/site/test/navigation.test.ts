import { describe, expect, it } from 'vitest';
import { navigationItem, resolveNavigation, themeNavigation, visibleNavigation } from '../src/navigation';
import { siteChromeDto, siteSettingsDto } from '../src/types';

const defaults = [
  navigationItem({ menu: 'primary', label: '首頁', href: '/', position: 0 }),
  navigationItem({ menu: 'primary', label: '品牌故事', href: '/story', position: 10, requiresContentKind: 'story' }),
  navigationItem({ menu: 'footer', groupLabel: '帳戶', label: '訂單查詢', href: '/account/orders', position: 0 }),
];

describe('navigation fallback', () => {
  it('uses the release defaults while the table is empty', () => {
    expect(resolveNavigation([], defaults)).toEqual(defaults);
  });

  it('replaces defaults one menu at a time', () => {
    const stored = [navigationItem({ menu: 'primary', label: '型錄', href: '/catalog', position: 0 })];
    const resolved = resolveNavigation(stored, defaults);
    expect(resolved.filter(item => item.menu === 'primary')).toEqual(stored);
    // 改了主導覽不該連頁尾一起消失（ADR 0046）。
    expect(resolved.filter(item => item.menu === 'footer')).toEqual(defaults.filter(item => item.menu === 'footer'));
  });

  it('orders each menu by position, not by insertion', () => {
    const stored = [
      navigationItem({ menu: 'primary', label: '後', href: '/b', position: 20 }),
      navigationItem({ menu: 'primary', label: '前', href: '/a', position: 5 }),
    ];
    expect(resolveNavigation(stored, []).map(item => item.label)).toEqual(['前', '後']);
  });
});

describe('content-kind visibility', () => {
  it('hides an item whose content kind has nothing published', () => {
    expect(visibleNavigation(defaults, []).map(item => item.href)).toEqual(['/', '/account/orders']);
  });

  it('keeps it once that kind is published', () => {
    expect(visibleNavigation(defaults, ['story']).map(item => item.href))
      .toEqual(['/', '/story', '/account/orders']);
  });
});

describe('theme projection', () => {
  it('keys items by menu and carries the group label', () => {
    expect(themeNavigation(defaults)).toEqual({
      primary: [{ label: '首頁', href: '/' }, { label: '品牌故事', href: '/story' }],
      footer: [{ label: '訂單查詢', href: '/account/orders', group: '帳戶' }],
    });
  });

  it('produces an empty record for an empty navigation', () => {
    expect(themeNavigation([])).toEqual({});
  });
});

describe('contracts', () => {
  it('rejects a navigation href that leaves the site', () => {
    expect(siteChromeDto.safeParse({
      settings: { tagline: '', footerNote: '' },
      navigation: [{ menu: 'primary', groupLabel: null, label: 'x', href: 'https://evil.example', position: 0, requiresContentKind: null }],
    }).success).toBe(false);
  });

  it('accepts a site-relative href', () => {
    expect(siteChromeDto.safeParse({
      settings: { tagline: '手織生活', footerNote: '' },
      navigation: [{ menu: 'primary', groupLabel: null, label: 'x', href: '/catalog', position: 0, requiresContentKind: null }],
    }).success).toBe(true);
  });

  it('caps the tagline so a settings edit cannot become the whole page', () => {
    expect(siteSettingsDto.safeParse({ tagline: 'x'.repeat(200), footerNote: '' }).success).toBe(false);
  });
});
