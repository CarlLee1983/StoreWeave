import { z } from 'zod';
import { PlatformError, defineQuery, type QueryContext } from '@storeweave/contracts';
import { productDto, searchProductsInput, searchProductsOutput } from './dto';
import { ProductRepository, toProductDto } from './repository';

const repository = new ProductRepository();

export const getProductQuery = defineQuery({
  name: 'commerce.catalog.getProduct',
  summary: '依 id 或 sku 取得商品',
  input: z.object({ id: z.string().uuid().optional(), sku: z.string().optional() }).strict().refine(
    (v) => Boolean(v.id || v.sku),
    { message: 'Either id or sku is required' },
  ),
  output: productDto,
  permission: 'catalog:read',
});

export const getProductHandler = async (input: { id?: string; sku?: string }, ctx: QueryContext) => {
  const row = input.id
    ? await repository.findById(ctx.db, input.id)
    : await repository.findBySku(ctx.db, input.sku!);
  if (!row) throw PlatformError.notFound('Product', input.id ?? input.sku);
  return toProductDto(row);
};

export const searchProductsQuery = defineQuery({
  name: 'commerce.catalog.searchProducts',
  summary: '搜尋商品',
  input: searchProductsInput,
  output: searchProductsOutput,
  permission: 'catalog:read',
});

export const searchProductsHandler = async (
  input: z.infer<typeof searchProductsInput>,
  ctx: QueryContext,
) => {
  const { items, total } = await repository.search(ctx.db, input);
  return { items: items.map(toProductDto), total };
};
