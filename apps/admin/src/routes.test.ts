import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE, NAV_SECTIONS, ROUTE_TABLE, firstVisibleRoute, isRoute, routeDefinition, visibleRoutes } from './routes';

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

/**
 * 側欄與命令面板只列出這個人做得到的事（B13 片3）。隱藏不是權限檢查——
 * 直接打 URL 仍然由後端授權，這裡管的是「不要給人按不動的按鈕」。
 */
describe('依權限與有效模組過濾路由', () => {
  const everything = { permissions: ['*'] as readonly string[], modules: ROUTE_TABLE.flatMap(entry => entry.module ? [entry.module] : []) };

  it('每一列都宣告了 permissions；空陣列是「登得進來就做得到」', () => {
    for (const entry of ROUTE_TABLE) {
      expect(Array.isArray(entry.permissions), entry.path).toBe(true);
    }
    // 只有自己的帳號那一頁不需要任何權限。
    expect(ROUTE_TABLE.filter(entry => entry.permissions.length === 0).map(entry => entry.path))
      .toEqual(['account']);
  });

  it('admin 的 wildcard 看得到全部', () => {
    expect(visibleRoutes(everything)).toHaveLength(ROUTE_TABLE.length);
  });

  it('少一個權限就少一列，而不是整組消失', () => {
    const orders = routeDefinition('orders');
    const visible = visibleRoutes({
      permissions: ROUTE_TABLE.flatMap(entry => entry.permissions).filter(key => !orders.permissions.includes(key)),
      modules: everything.modules,
    });
    expect(visible.map(entry => entry.path)).not.toContain('orders');
    expect(visible.map(entry => entry.path)).toContain('system');
  });

  it('模組沒有載入時，那一頁不出現在側欄', () => {
    const visible = visibleRoutes({ permissions: ['*'], modules: everything.modules.filter(name => name !== 'rma') });
    expect(visible.map(entry => entry.path)).not.toContain('rmas');
  });

  it('沒有任何權限的人只看得到自己的帳號', () => {
    expect(visibleRoutes({ permissions: [], modules: everything.modules }).map(entry => entry.path))
      .toEqual(['account']);
  });

  it('起始路由落在看得到的那一列上，預設路由被藏起來也一樣', () => {
    expect(firstVisibleRoute(visibleRoutes(everything))).toBe(DEFAULT_ROUTE);
    const withoutCatalog = visibleRoutes({
      permissions: ROUTE_TABLE.flatMap(entry => entry.permissions).filter(key => key !== 'catalog:read'),
      modules: everything.modules,
    });
    expect(firstVisibleRoute(withoutCatalog)).not.toBe(DEFAULT_ROUTE);
    expect(firstVisibleRoute([])).toBeNull();
  });
});
