import { z } from 'zod';
import { PlatformError, defineQuery, type QueryContext } from '@storeweave/contracts';
import { customerService } from '@storeweave/customer';
import { couponPromotionService } from '@storeweave/promotion';
import { describeRule } from './describe';
import {
  attributionSummaryInput,
  attributionSummaryOutput,
  couponDto,
  getCouponInput,
  listCouponsInput,
  listCouponsOutput,
  promotionPerformanceInput,
  promotionPerformanceOutput,
  listMyCouponsInput,
  listMyCouponsOutput,
} from './dto';
import { CouponRepository, toCouponDto } from './repository';
import { couponService, type CouponRejection } from './service';

const repository = new CouponRepository();

/**
 * 拒絕原因對應到畫面上的狀態。券本身的原因與活動造成的原因分開說：
 * 「這張券過期了」與「這檔活動結束了」對顧客是兩件不同的事。
 */
type CouponState = 'used' | 'void' | 'not_started' | 'expired' | 'promotion_ended';

/** 券本身的問題。 */
const COUPON_REASON_STATE: Record<CouponRejection, CouponState> = {
  not_found: 'void',
  not_started: 'not_started',
  expired: 'expired',
  void: 'void',
  used: 'used',
  not_eligible: 'void',
  used_up: 'promotion_ended',
  already_redeemed: 'promotion_ended',
};

/** 活動或額度造成的問題。券本身沒事。 */
const PROMOTION_REASON_STATE: Record<CouponRejection, CouponState> = {
  ...COUPON_REASON_STATE,
  void: 'promotion_ended',
  not_started: 'promotion_ended',
  expired: 'promotion_ended',
};

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

export function createAttributionSummaryHandler(deps: { currency: string }) {
  return async (input: z.infer<typeof attributionSummaryInput>, ctx: QueryContext) => ({
    currency: deps.currency,
    items: await repository.attributionSummary(ctx.db, input),
  });
}

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
      const promotion = await couponPromotionService.describeForCoupon(ctx.db, row.promotionId);
      // 規則壞掉的券不該讓整頁壞掉，但也不能假裝它有面額。
      if (!promotion) continue;

      // 「能不能用」與套用、結帳問的是同一支：這裡自己算一份的話，
      // 「我的券」會說可使用而套用時說不行——那正是這個共用判斷要消滅的落差。
      const basic = couponService.check(row, { customerId: me.customerId, now: ctx.now });
      const resolution = basic.ok
        ? await couponService.checkAgainstLedger(ctx.db, row, { customerId: me.customerId, now: ctx.now })
        : basic;
      const usable = resolution.ok;
      if (input.usableOnly && !usable) continue;

      // 把「不能用」拆回它真正的原因。全部顯示成「已過期」的話，顧客會去找別張券，
      // 而問題其實是活動被停掉了。同一個 `void` 在券那一層與活動那一層意思不同，
      // 因此看它是哪一段判斷回的。
      const unusableReason = usable ? null
        : !basic.ok ? COUPON_REASON_STATE[basic.reason]
          : PROMOTION_REASON_STATE[resolution.reason];

      result.push({
        code: row.code,
        promotionName: promotion.name,
        status: row.status as 'issued' | 'used' | 'void',
        description: describeRule(promotion.rule, money),
        endsAt: row.endsAt,
        expiringSoon: usable && row.endsAt !== null && row.endsAt.getTime() - ctx.now.getTime() <= soonMs,
        usable,
        unusableReason,
      });
    }
    return { items: result };
  };
}

export const promotionPerformanceQuery = defineQuery({
  name: 'commerce.coupon.promotionPerformance',
  summary: '每一檔活動的核銷次數、折抵總額、訂單數與營收',
  input: promotionPerformanceInput,
  output: promotionPerformanceOutput,
  permission: 'analytics:read',
});

export function createPromotionPerformanceHandler(deps: { currency: string }) {
  return async (input: z.infer<typeof promotionPerformanceInput>, ctx: QueryContext) => {
    const rows = await repository.promotionPerformance(ctx.db, input);
    const items = [];
    for (const row of rows) {
      const promotion = await couponPromotionService.findForCoupon(ctx.db, row.promotionId);
      // 活動被刪掉時仍然要看得到數字：錢已經花出去了，報表不該假裝沒發生。
      items.push({ ...row, name: promotion?.name ?? row.promotionId });
    }
    return { currency: deps.currency, items };
  };
}
