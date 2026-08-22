import { z } from 'zod';
import { PlatformError, defineQuery, type QueryContext } from '@storeweave/contracts';
import { couponDto, getCouponInput, listCouponsInput, listCouponsOutput } from './dto';
import { CouponRepository, toCouponDto } from './repository';

const repository = new CouponRepository();

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
