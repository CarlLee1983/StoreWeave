import { z } from 'zod';
import { PlatformError } from '@storeweave/contracts';
import { definePage, type PageResolveContext, type StorefrontHttpContract } from '@storeweave/kernel';
import type { JsonSchema7Type } from 'zod-to-json-schema';

/** 一件可販售商品在前台看得到的樣子。庫存查不到時是 null，不是 0。 */
export interface ThemeProductView {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  available: number | null;
}

/** Public catalog result: filtering and pagination remain server-derived. */
export interface ThemeCatalogView {
  products: ThemeProductView[];
  q: string;
  /** Whole currency units supplied by the public form; null means unbounded. */
  minPrice: number | null;
  maxPrice: number | null;
  page: number;
  pageSize: number;
  total: number;
}

export const CATALOG_PAGE_SIZE = 24;

interface ProductDtoShape {
  id: string; sku: string; name: string; description: string | null;
  priceCents: number; currency: string; status: string;
}

const jsonSchema = (fields: readonly string[]): JsonSchema7Type => ({
  type: 'object',
  properties: Object.fromEntries(fields.map(field => [field, { type: 'string' }])),
  additionalProperties: true,
} as JsonSchema7Type);

const htmlOnly: StorefrontHttpContract['responses'] = [
  { kind: 'html', status: 200, contentType: 'text/html; charset=utf-8', body: 'theme' },
  { kind: 'html', status: 'platform-error', contentType: 'text/html; charset=utf-8', body: 'theme' },
];

/**
 * 前台的搜尋條件全部是字串，錯誤訊息要說得出哪一個欄位不對——用 coerce 會把
 * 「abc」變成 NaN 再一路傳到查詢，所以這裡逐項驗形狀而不是硬轉型。
 */
const catalogInput = z.object({
  q: z.string().optional().transform(value => value?.trim() ?? ''),
  minPrice: z.string().regex(/^\d*$/, 'Minimum price must be a nonnegative whole amount').optional(),
  maxPrice: z.string().regex(/^\d*$/, 'Maximum price must be a nonnegative whole amount').optional(),
  page: z.string().regex(/^[1-9]\d*$/, 'Page must be a positive integer').optional(),
}).transform(input => {
  const amount = (value: string | undefined, label: string): number | null => {
    if (value === undefined || value === '') return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed > Math.floor(Number.MAX_SAFE_INTEGER / 100)) {
      throw PlatformError.validation(`${label} is too large`);
    }
    return parsed;
  };
  const minPrice = amount(input.minPrice, 'Minimum price');
  const maxPrice = amount(input.maxPrice, 'Maximum price');
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
    throw PlatformError.validation('Maximum price must be greater than or equal to minimum price');
  }
  const page = input.page === undefined || input.page === '' ? 1 : Number(input.page);
  if (!Number.isSafeInteger(page) || (page - 1) * CATALOG_PAGE_SIZE > Number.MAX_SAFE_INTEGER) {
    throw PlatformError.validation('Page is too large');
  }
  return { q: input.q, minPrice, maxPrice, page };
});

/** 庫存查不到不該讓整個目錄頁失敗；顯示「無庫存資訊」比顯示錯誤頁誠實。 */
async function withStock(ctx: PageResolveContext, product: ProductDtoShape): Promise<ThemeProductView> {
  try {
    const stock = await ctx.queries.execute<{ available: number }>(
      'commerce.inventory.getStock', { productId: product.id }, { actor: ctx.actor },
    );
    return { ...product, available: stock.available };
  } catch {
    return { ...product, available: null };
  }
}

async function searchCatalog(
  ctx: PageResolveContext,
  input: { q: string; minPrice: number | null; maxPrice: number | null; page: number },
): Promise<ThemeCatalogView> {
  const result = await ctx.queries.execute<{ items: ProductDtoShape[]; total: number }>(
    'commerce.catalog.searchProducts',
    {
      ...(input.q ? { q: input.q } : {}),
      ...(input.minPrice !== null ? { minPriceCents: input.minPrice * 100 } : {}),
      ...(input.maxPrice !== null ? { maxPriceCents: input.maxPrice * 100 } : {}),
      status: 'active', limit: CATALOG_PAGE_SIZE, offset: (input.page - 1) * CATALOG_PAGE_SIZE,
    },
    { actor: ctx.actor },
  );
  return {
    products: await Promise.all(result.items.map(product => withStock(ctx, product))),
    q: input.q, minPrice: input.minPrice, maxPrice: input.maxPrice,
    page: input.page, pageSize: CATALOG_PAGE_SIZE, total: result.total,
  };
}

export const catalogPages = {
  catalog: definePage({
    id: 'commerce.catalog.view',
    path: '/catalog',
    method: 'get',
    audience: 'public',
    input: catalogInput,
    contract: {
      kind: 'storefront', request: 'query', input: jsonSchema(['q', 'minPrice', 'maxPrice', 'page']),
      responses: htmlOnly, cookieEffects: ['cart-notice-consume'],
    },
    resolve: async (ctx, input) => ({ kind: 'view', view: await searchCatalog(ctx, input) }),
  }),

  product: definePage({
    id: 'commerce.catalog.product',
    path: '/p/:id',
    method: 'get',
    audience: 'public',
    input: z.object({ id: z.string() }),
    contract: {
      kind: 'storefront', request: 'none', input: jsonSchema(['id']), params: { id: 'id' },
      responses: htmlOnly, cookieEffects: ['cart-notice-consume'],
    },
    resolve: async (ctx, { id }) => {
      const product = await ctx.queries.execute<ProductDtoShape>(
        'commerce.catalog.getProduct', { id }, { actor: ctx.actor },
      );
      // 下架商品對前台等於不存在；回 404 而不是一頁「這個商品已下架」，
      // 否則下架與否會從公開網址被推斷出來。
      if (product.status !== 'active') return { kind: 'not-found' };
      return { kind: 'view', view: { product: await withStock(ctx, product) } };
    },
  }),
} as const;

export type CatalogPages = typeof catalogPages;
