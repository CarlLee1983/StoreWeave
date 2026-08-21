import { z } from 'zod';

export const productStatus = z.enum(['draft', 'active', 'archived']);
export type ProductStatus = z.infer<typeof productStatus>;

/** 公開 DTO。API、MCP、Admin、Extension 全部只看得到這個形狀。 */
export const productDto = z.object({
  id: z.string().uuid(),
  sku: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  priceCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  status: productStatus,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ProductDto = z.infer<typeof productDto>;

export const createProductInput = z.object({
  sku: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  priceCents: z.number().int().nonnegative(),
  currency: z.string().length(3).default('TWD'),
  status: productStatus.default('active'),
});
export type CreateProductInput = z.infer<typeof createProductInput>;

export const updateProductInput = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  priceCents: z.number().int().nonnegative().optional(),
  status: productStatus.optional(),
});

export const searchProductsInput = z.object({
  q: z.string().max(200).optional(),
  status: productStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const searchProductsOutput = z.object({
  items: z.array(productDto),
  total: z.number().int().nonnegative(),
});
