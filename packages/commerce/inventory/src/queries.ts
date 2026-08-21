import type { z } from 'zod';
import { PlatformError, defineQuery, type QueryContext } from '@storeweave/contracts';
import { getStockInput, listStockInput, listStockOutput, stockDto } from './dto';
import { StockRepository, toStockDto } from './repository';

const repository = new StockRepository();

export const getStockQuery = defineQuery({
  name: 'commerce.inventory.getStock',
  summary: '查詢單一商品庫存',
  input: getStockInput,
  output: stockDto,
  permission: 'inventory:read',
});

export const getStockHandler = async (input: z.infer<typeof getStockInput>, ctx: QueryContext) => {
  const row = await repository.find(ctx.db, input.productId);
  if (!row) throw PlatformError.notFound('Stock', input.productId);
  return toStockDto(row);
};

export const listStockQuery = defineQuery({
  name: 'commerce.inventory.listStock',
  summary: '列出庫存（可篩低於門檻者）',
  input: listStockInput,
  output: listStockOutput,
  permission: 'inventory:read',
});

export const listStockHandler = async (input: z.infer<typeof listStockInput>, ctx: QueryContext) => {
  const { items, total } = await repository.list(ctx.db, input);
  return { items: items.map(toStockDto), total };
};
