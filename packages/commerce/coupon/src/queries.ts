import { z } from 'zod';
import { PlatformError, defineQuery, type QueryContext } from '@storeweave/contracts';
import { customerService } from '@storeweave/customer';
import { PromotionRepository, tryToPromotionDto } from '@storeweave/promotion';
import { describeRule } from './describe';
import {
  attributionSummaryInput,
  attributionSummaryOutput,
  couponDto,
  getCouponInput,
  listCouponsInput,
  listCouponsOutput,
  listMyCouponsInput,
  listMyCouponsOutput,
} from './dto';
import { CouponRepository, toCouponDto } from './repository';

const repository = new CouponRepository();
const promotions = new PromotionRepository();

/** 到期前幾天算「即將到期」。七天足夠讓人安排一次購物。 */
const EXPIRING_SOON_DAYS = 7;

export const getCouponQuery = defineQuery({
  name: 'commerce.coupon.getCoupon',
  summary: '以碼查一張券',
  input: getCouponInput,
  output: couponDto,
  permission: 'coupon:read',
});

export const getCouponHandler = async (input: z.infer<typeof getCouponInput>, ctx: QueryContext) => {
  const row = await repository.findByCode(ctx.db, input.code);
  if (!row) throw PlatformError.notFound('Coupon', input.code);
  return toCouponDto(row);
};

export const listCouponsQuery = defineQuery({
  name: 'commerce.coupon.listCoupons',
  summary: '列出券',
  input: listCouponsInput,
  output: listCouponsOutput,
  permission: 'coupon:read',
});

export const listCouponsHandler = async (input: z.infer<typeof listCouponsInput>, ctx: QueryContext) => {
  const { items, total } = await repository.list(ctx.db, input);
  return { items: items.map(toCouponDto), total };
};

export const attributionSummaryQuery = defineQuery({
  name: 'commerce.coupon.attributionSummary',
  summary: '依合作夥伴分組的行銷碼成效',
  input: attributionSummaryInput,
  output: attributionSummaryOutput,
  permission: 'analytics:read',
});

export const attributionSummaryHandler = async (
  input: z.infer<typeof attributionSummaryInput>,
  ctx: QueryContext,
) => ({ items: await repository.attributionSummary(ctx.db, input) });

export const listMyCouponsQuery = defineQuery({
  name: 'commerce.coupon.listMyCoupons',
  summary: '我的券',
  input: listMyCouponsInput,
  output: listMyCouponsOutput,
  // 範圍限縮在 handler：這支只回自己的券，永遠不吃呼叫端給的顧客識別。
  permission: 'customer:read',
});

export function createListMyCouponsHandler(deps: { currency: string; locale: string }) {
  const money = (cents: number) => {
    try {
      return new Intl.NumberFormat(deps.locale, { style: 'currency', currency: deps.currency }).format(cents / 100);
    } catch {
      return `${(cents / 100).toFixed(2)} ${deps.currency}`;
    }
  };

  return async (input: z.infer<typeof listMyCouponsInput>, ctx: QueryContext) => {
    const me = await customerService.requireByActor(ctx.db, ctx.actor);
    const { items } = await repository.list(ctx.db, { customerId: me.customerId, limit: 200, offset: 0 });
    const soonMs = EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000;

    const result = [];
    for (const row of items) {
      const promotionRow = await promotions.findById(ctx.db, row.promotionId);
      const promotion = promotionRow ? tryToPromotionDto(promotionRow) : null;
      // 規則壞掉的券不該讓整頁壞掉，但也不能假裝它有面額。
      if (!promotion) continue;

      const expired = row.endsAt !== null && row.endsAt.getTime() <= ctx.now.getTime();
      const notStarted = row.startsAt !== null && row.startsAt.getTime() > ctx.now.getTime();
      const usable = row.status === 'issued' && !expired && !notStarted && promotion.status === 'active';
      if (input.usableOnly && !usable) continue;

      result.push({
        code: row.code,
        promotionName: promotion.name,
        status: row.status as 'issued' | 'used' | 'void',
        description: describeRule(promotion.rule, money),
        endsAt: row.endsAt,
        expiringSoon: usable && row.endsAt !== null && row.endsAt.getTime() - ctx.now.getTime() <= soonMs,
        usable,
      });
    }
    return { items: result };
  };
}
