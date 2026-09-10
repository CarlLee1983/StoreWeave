import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '@storeweave/contracts';
import type { PageResolveContext } from '@storeweave/kernel';
import { CATALOG_PAGE_SIZE, catalogPages } from '../src/pages';

const anonymous: Actor = { id: 'anon', type: 'customer', permissions: [] };

const product = (over: Record<string, unknown> = {}) => ({
  id: 'p1', sku: 'SKU-1', name: '陶碗', description: null,
  priceCents: 48000, currency: 'TWD', status: 'active', ...over,
});

const ctxWith = (execute: PageResolveContext['queries']['execute']): PageResolveContext => ({
  queries: { execute },
  commands: { execute: vi.fn() },
  actor: anonymous,
  locale: 'zh-TW',
  clientKey: 'test-client',
  cookies: { guestCartToken: () => null, ensureGuestCart: () => 'guest-token' },
  providers: {
    get: () => { throw new Error('目錄頁不需要 provider'); },
    has: () => false,
  },
});

describe('目錄頁', () => {
  const parse = (raw: Record<string, string>) => catalogPages.catalog.input.parse(raw);

  it('沒有條件時查第一頁的上架商品', async () => {
    const execute = vi.fn(async (name: string) => name === 'commerce.catalog.searchProducts'
      ? { items: [product()], total: 1 } : { available: 3 });

    const outcome = await catalogPages.catalog.resolve(ctxWith(execute as never), parse({}));

    expect(execute).toHaveBeenCalledWith('commerce.catalog.searchProducts',
      { status: 'active', limit: CATALOG_PAGE_SIZE, offset: 0 }, { actor: anonymous });
    expect(outcome).toMatchObject({ kind: 'view', view: { total: 1, page: 1, q: '' } });
  });

  it('價格條件換算成分，頁碼換算成 offset', async () => {
    const execute = vi.fn(async () => ({ items: [], total: 0 }));

    await catalogPages.catalog.resolve(ctxWith(execute as never), parse({ q: ' 碗 ', minPrice: '100', maxPrice: '900', page: '3' }));

    expect(execute).toHaveBeenCalledWith('commerce.catalog.searchProducts',
      { q: '碗', minPriceCents: 10_000, maxPriceCents: 90_000, status: 'active', limit: CATALOG_PAGE_SIZE, offset: CATALOG_PAGE_SIZE * 2 },
      { actor: anonymous });
  });

  it('最低價高於最高價是輸入錯誤', () => {
    expect(() => parse({ minPrice: '900', maxPrice: '100' })).toThrow(/greater than or equal/);
  });

  it('頁碼與價格只接受正整數字串', () => {
    expect(() => parse({ page: '0' })).toThrow();
    expect(() => parse({ page: 'abc' })).toThrow();
    expect(() => parse({ minPrice: '-1' })).toThrow();
  });

  it('庫存查詢失敗時商品仍然列出，available 是 null 而不是 0', async () => {
    const execute = vi.fn(async (name: string) => {
      if (name === 'commerce.catalog.searchProducts') return { items: [product()], total: 1 };
      throw new Error('inventory unavailable');
    });

    const outcome = await catalogPages.catalog.resolve(ctxWith(execute as never), parse({}));

    expect(outcome).toMatchObject({ view: { products: [{ id: 'p1', available: null }] } });
  });
});

describe('商品頁', () => {
  it('上架商品帶著庫存渲染', async () => {
    const execute = vi.fn(async (name: string) => name === 'commerce.catalog.getProduct'
      ? product() : { available: 5 });

    const outcome = await catalogPages.product.resolve(ctxWith(execute as never), { id: 'p1' });

    expect(outcome).toMatchObject({ kind: 'view', view: { product: { id: 'p1', available: 5 } } });
  });

  it('下架商品對前台等於不存在', async () => {
    const execute = vi.fn(async () => product({ status: 'draft' }));

    const outcome = await catalogPages.product.resolve(ctxWith(execute as never), { id: 'p1' });

    expect(outcome).toEqual({ kind: 'not-found' });
  });
});

describe('首頁', () => {
  const parse = (raw: Record<string, string>) => catalogPages.home.input.parse(raw);

  it('目錄與品牌內容摘要一起取回', async () => {
    const execute = vi.fn(async (name: string, input: any) => {
      if (name === 'commerce.catalog.searchProducts') return { items: [product()], total: 1 };
      if (name === 'commerce.inventory.getStock') return { available: 2 };
      return { items: [{ kind: input.kind, slug: `${input.kind}-1`, title: 't', summary: 's', section: 'x', body: [], imageKey: null, publishedAt: '2026-01-01' }] };
    });

    const outcome = await catalogPages.home.resolve(ctxWith(execute as never), parse({}));

    expect(outcome).toMatchObject({
      kind: 'view',
      view: { total: 1, story: { slug: 'story-1' }, journal: [{ slug: 'journal-1' }], news: [{ slug: 'news-1' }] },
    });
  });

  it('沒有 content 模組時首頁照樣出得來，摘要是空的', async () => {
    const execute = vi.fn(async (name: string) => {
      if (name === 'commerce.catalog.searchProducts') return { items: [], total: 0 };
      if (name === 'commerce.inventory.getStock') return { available: 0 };
      throw new Error('unknown query: commerce.content.listPublishedArticles');
    });

    const outcome = await catalogPages.home.resolve(ctxWith(execute as never), parse({}));

    expect(outcome).toMatchObject({ kind: 'view', view: { story: null, journal: [], news: [] } });
  });
});
