import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE, NAV_SECTIONS, ROUTE_TABLE, isRoute, routeDefinition } from './routes';

/**
 * 路由表本身的不變條件（工單 02）。
 * 這些斷言的用途是：之後加一列新頁面時，漏填的欄位會在這裡被擋下來。
 */

describe('路由表', () => {
  it('每一列的 path 都是唯一的', () => {
    const paths = ROUTE_TABLE.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('每一列都有導覽標籤、圖示、標題與副標題', () => {
    for (const entry of ROUTE_TABLE) {
      expect(entry.navLabel, entry.path).toBeTruthy();
      expect(entry.icon, entry.path).toBeTruthy();
      expect(entry.title, entry.path).toBeTruthy();
      expect(entry.subtitle, entry.path).toBeTruthy();
      expect(typeof entry.render, entry.path).toBe('function');
    }
  });

  it('每一列都落在已知的側欄分組裡', () => {
    for (const entry of ROUTE_TABLE) {
      expect(NAV_SECTIONS).toContain(entry.section);
    }
  });

  it('預設路由存在於表中', () => {
    expect(isRoute(DEFAULT_ROUTE)).toBe(true);
  });

  it('isRoute 只認得表裡的路由', () => {
    expect(isRoute('products')).toBe(true);
    expect(isRoute('does-not-exist')).toBe(false);
    expect(isRoute('')).toBe(false);
  });

  it('routeDefinition 對未知路由丟出錯誤，而不是回傳 undefined', () => {
    expect(() => routeDefinition('nope' as never)).toThrow(/未知的路由/);
    expect(routeDefinition('dlq').title).toBe('dlqTitle');
  });

  it('有主要動作的頁面必須指名捲動目標', () => {
    for (const entry of ROUTE_TABLE) {
      if (!entry.action) continue;
      expect(entry.action.label, entry.path).toBeTruthy();
      expect(entry.action.targetId, entry.path).toBeTruthy();
    }
  });
});
