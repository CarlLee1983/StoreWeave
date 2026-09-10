import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assertThemeCoversPages, collectPages, definePage, SYSTEM_PAGE_IDS } from '../src/page';
import { defineModule } from '../src/module';
import type { PlatformModule } from '../src/module';
import type { StorefrontTheme } from '../src/theme';

const page = (id: string, path: string, required?: boolean) => definePage({
  id,
  path,
  method: 'get',
  audience: 'public',
  input: z.object({}),
  contract: { kind: 'storefront', request: 'none', input: { type: 'object' }, responses: [] },
  ...(required === undefined ? {} : { required }),
  resolve: async () => ({ kind: 'view', view: {} }),
});

const moduleWith = (name: string, pages: Record<string, ReturnType<typeof page>>): PlatformModule =>
  defineModule({ name, version: '1.0.0', baseVersionRange: '^1.0.0', pages });

const themeWith = (...ids: string[]): StorefrontTheme => ({
  id: 'test-theme',
  name: 'Test',
  optionsSchema: z.object({}),
  renderers: Object.fromEntries([...SYSTEM_PAGE_IDS, ...ids].map(id => [id, () => '<html></html>'])),
});

describe('頁面註冊表', () => {
  it('收集所有已載入模組宣告的頁面', () => {
    const pages = collectPages([
      moduleWith('a', { home: page('platform.home', '/') }),
      moduleWith('b', { cart: page('commerce.cart.view', '/cart') }),
    ]);

    expect(pages.map(p => p.id)).toEqual(['platform.home', 'commerce.cart.view']);
  });

  it('沒有前台的模組不影響收集', () => {
    const bare = defineModule({ name: 'jobs-only', version: '1.0.0', baseVersionRange: '^1.0.0' });

    expect(collectPages([bare])).toEqual([]);
  });

  it('兩個模組宣告同一個 page id 是組裝錯誤，不是先到先得', () => {
    const modules = [
      moduleWith('a', { home: page('platform.home', '/') }),
      moduleWith('b', { home: page('platform.home', '/other') }),
    ];

    expect(() => collectPages(modules)).toThrow(/platform\.home/);
  });

  it('兩個模組宣告同一條 path 也是組裝錯誤', () => {
    const modules = [
      moduleWith('a', { home: page('platform.home', '/') }),
      moduleWith('b', { landing: page('site.landing', '/') }),
    ];

    expect(() => collectPages(modules)).toThrow(/'\/'/);
  });

  it('錯誤頁沒有路由但每個 Theme 都要有；缺了就拒絕啟動', () => {
    expect(() => assertThemeCoversPages([], { ...themeWith(), renderers: {} }))
      .toThrow(/platform\.error/);
  });

  it('theme 缺必需頁面時拒絕啟動，訊息列出缺的是哪幾頁', () => {
    const modules = [moduleWith('a', {
      home: page('platform.home', '/'),
      cart: page('commerce.cart.view', '/cart'),
      checkout: page('commerce.checkout.view', '/checkout'),
    })];

    expect(() => assertThemeCoversPages(modules, themeWith('platform.home')))
      .toThrow(/commerce\.cart\.view.*commerce\.checkout\.view|commerce\.checkout\.view.*commerce\.cart\.view/s);
  });

  it('required: false 的頁面缺 renderer 不阻擋啟動', () => {
    const modules = [moduleWith('a', {
      home: page('platform.home', '/'),
      add: page('commerce.cart.add', '/cart/add', false),
    })];

    expect(() => assertThemeCoversPages(modules, themeWith('platform.home'))).not.toThrow();
  });

  it('theme 涵蓋所有必需頁面時通過', () => {
    const modules = [moduleWith('a', {
      home: page('platform.home', '/'),
      cart: page('commerce.cart.view', '/cart'),
    })];

    expect(() => assertThemeCoversPages(modules, themeWith('platform.home', 'commerce.cart.view'))).not.toThrow();
  });

  it('theme 多提供了沒人宣告的 renderer 不算錯，模組可能沒載入', () => {
    const modules = [moduleWith('a', { home: page('platform.home', '/') })];

    expect(() => assertThemeCoversPages(modules, themeWith('platform.home', 'commerce.cart.view'))).not.toThrow();
  });
});
