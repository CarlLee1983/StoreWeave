import { z } from 'zod';
import { definePage, type StorefrontHttpContract } from '@storeweave/kernel';
import type { JsonSchema7Type } from 'zod-to-json-schema';

/** 會員中心「我的券」頁看到的樣子。 */
export interface ThemeAccountCouponsView {
  coupons: {
    code: string;
    promotionName: string;
    /** 這張券折什麼，已經是可以直接顯示的句子。 */
    description: string;
    status: 'issued' | 'used' | 'void';
    endsAt: Date | null;
    expiringSoon: boolean;
    usable: boolean;
    /** 不能用的原因；可以用時為 null。 */
    unusableReason: 'used' | 'void' | 'not_started' | 'expired' | 'promotion_ended' | null;
  }[];
}

const jsonSchema = (fields: readonly string[]): JsonSchema7Type => ({
  type: 'object',
  properties: Object.fromEntries(fields.map(field => [field, { type: 'string' }])),
  additionalProperties: true,
} as JsonSchema7Type);

type StorefrontResponse = StorefrontHttpContract['responses'][number];

const html = (status: number | 'platform-error' = 200): StorefrontResponse =>
  ({ kind: 'html', status, contentType: 'text/html; charset=utf-8', body: 'theme' });
const redirect = (location: Extract<StorefrontResponse, { kind: 'redirect' }>['location']): StorefrontResponse =>
  ({ kind: 'redirect', status: 303, location });

export const couponPages = {
  accountList: definePage({
    id: 'commerce.coupon.accountList',
    path: '/account/coupons',
    method: 'get',
    audience: 'customer',
    input: z.object({}),
    contract: {
      kind: 'storefront', request: 'none', input: jsonSchema([]), audience: 'customer',
      responses: [html(), html('platform-error'), redirect({ kind: 'server-constructed' })],
      cookieEffects: ['cart-notice-consume'],
    },
    resolve: async ctx => {
      const result = await ctx.queries.execute<{ items: ThemeAccountCouponsView['coupons'] }>(
        'commerce.coupon.listMyCoupons', {}, { actor: ctx.actor },
      );
      return { kind: 'view', view: { coupons: result.items } };
    },
  }),
} as const;

export type CouponPages = typeof couponPages;
