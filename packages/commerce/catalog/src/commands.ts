import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import { createProductInput, productDto, updateProductInput, type ProductDto } from './dto';
import { ProductRepository, toProductDto } from './repository';
import { productCreatedV1, productUpdatedV1 } from './events';

const repository = new ProductRepository();

export const createProductCommand = defineCommand({
  name: 'commerce.catalog.createProduct',
  summary: '建立商品',
  input: createProductInput,
  output: productDto,
  permission: 'catalog:write',
  idempotency: 'optional',
  audit: {
    action: 'catalog.product.created',
    resourceType: 'product',
    resourceId: (_i, o: ProductDto) => o.id,
    redact: (i) => ({ sku: i.sku, name: i.name, priceCents: i.priceCents }),
  },
});

export const createProductHandler = async (
  input: z.infer<typeof createProductInput>,
  ctx: CommandContext,
): Promise<ProductDto> => {
  const existing = await repository.findBySku(ctx.tx, input.sku);
  if (existing) throw PlatformError.conflict(`SKU "${input.sku}" already exists`);

  const row = await repository.insert(ctx.tx, {
    id: randomUUID(),
    sku: input.sku,
    name: input.name,
    description: input.description ?? null,
    priceCents: input.priceCents,
    currency: input.currency,
    status: input.status,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  const dto = toProductDto(row);

  await ctx.publish({
    name: productCreatedV1.name,
    payload: {
      productId: dto.id,
      sku: dto.sku,
      name: dto.name,
      priceCents: dto.priceCents,
      currency: dto.currency,
      status: dto.status,
    },
  });
  return dto;
};

export const updateProductCommand = defineCommand({
  name: 'commerce.catalog.updateProduct',
  summary: '更新商品',
  input: updateProductInput,
  output: productDto,
  permission: 'catalog:write',
  idempotency: 'optional',
  audit: { action: 'catalog.product.updated', resourceType: 'product', resourceId: (i) => i.id },
});

export const updateProductHandler = async (
  input: z.infer<typeof updateProductInput>,
  ctx: CommandContext,
): Promise<ProductDto> => {
  const { id, ...patch } = input;
  const changed = Object.entries(patch).filter(([, v]) => v !== undefined).map(([k]) => k);
  if (changed.length === 0) throw PlatformError.validation('No fields to update');

  const row = await repository.update(ctx.tx, id, patch as any);
  if (!row) throw PlatformError.notFound('Product', id);
  const dto = toProductDto(row);

  await ctx.publish({ name: productUpdatedV1.name, payload: { productId: dto.id, sku: dto.sku, changed } });
  return dto;
};
