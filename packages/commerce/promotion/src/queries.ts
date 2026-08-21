import { z } from 'zod';
import { PlatformError, defineQuery, type QueryContext } from '@storeweave/contracts';
import { getPromotionInput, listPromotionsInput, listPromotionsOutput, promotionDto } from './dto';
import { PromotionRepository, toPromotionDto } from './repository';

const repository = new PromotionRepository();

export const getPromotionQuery = defineQuery({
  name: 'commerce.promotion.getPromotion',
  summary: '取得單一促銷活動',
  input: getPromotionInput,
  output: promotionDto,
  permission: 'promotion:read',
});

export const getPromotionHandler = async (input: z.infer<typeof getPromotionInput>, ctx: QueryContext) => {
  const row = await repository.findById(ctx.db, input.id);
  if (!row) throw PlatformError.notFound('Promotion', input.id);
  return toPromotionDto(row);
};

export const listPromotionsQuery = defineQuery({
  name: 'commerce.promotion.listPromotions',
  summary: '列出促銷活動',
  input: listPromotionsInput,
  output: listPromotionsOutput,
  permission: 'promotion:read',
});

export const listPromotionsHandler = async (
  input: z.infer<typeof listPromotionsInput>,
  ctx: QueryContext,
) => {
  const { items, total } = await repository.list(ctx.db, input);
  return { items: items.map(toPromotionDto), total };
};
