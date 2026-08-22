import { z } from 'zod';
import { PlatformError, defineQuery, type QueryContext } from '@storeweave/contracts';
import { catalogService } from '@storeweave/catalog';
import { getPromotionInput, listPromotionsInput, listPromotionsOutput, promotionDto, quoteInput, quoteOutput } from './dto';
import { PromotionRepository, toPromotionDto } from './repository';
import { pricingService } from './service';

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

export const quoteQuery = defineQuery({
  name: 'commerce.promotion.quote',
  summary: '結帳前試算：算出這組商品現在多少錢、套用了哪些折扣',
  input: quoteInput,
  output: quoteOutput,
  permission: 'promotion:quote',
});

/**
 * 與結帳走同一個定價引擎與同一份活動載入，差別只在這裡不寫入任何東西、
 * 不預留庫存、不鎖定任何額度——試算看到的金額因此就是實際會扣的金額。
 */
export function createQuoteHandler(deps: { defaultCurrency: string }) {
  return async (input: z.infer<typeof quoteInput>, ctx: QueryContext) => {
  // 幣別的判斷必須與 placeOrder 逐字相同，否則會出現「試算得到、下單被擋」。
  const currency = deps.defaultCurrency;
  const lines = [];
  for (const [index, line] of input.lines.entries()) {
    const product = await catalogService.requireActiveProduct(ctx.db, line.productId);
    if (product.currency !== currency) {
      throw PlatformError.validation(`Product ${product.sku} is priced in ${product.currency}, order is ${currency}`);
    }
    lines.push({
      lineId: String(index),
      productId: product.id,
      sku: product.sku,
      name: product.name,
      unitPriceCents: product.priceCents,
      quantity: line.quantity,
    });
  }

  const pricing = await pricingService.quote(ctx.db, {
    lines: lines.map(({ lineId, productId, unitPriceCents, quantity }) => ({ lineId, productId, unitPriceCents, quantity })),
    now: ctx.now,
    logger: ctx.logger,
  });
  const priced = new Map(pricing.lines.map((l) => [l.lineId, l]));

  return {
    currency,
    subtotalCents: pricing.subtotalCents,
    discountCents: pricing.discountCents,
    shippingCents: pricing.shippingCents,
    taxCents: pricing.taxCents,
    totalCents: pricing.totalCents,
    adjustments: pricing.adjustments,
    nextThreshold: pricing.nextThreshold,
    lines: lines.map((line) => ({
      productId: line.productId,
      sku: line.sku,
      name: line.name,
      unitPriceCents: line.unitPriceCents,
      quantity: line.quantity,
      lineTotalCents: priced.get(line.lineId)!.lineTotalCents,
      discountCents: priced.get(line.lineId)!.discountCents,
      netCents: priced.get(line.lineId)!.netCents,
    })),
  };
  };
}
