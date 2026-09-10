import { z } from 'zod';
import { definePage, type StorefrontHttpContract } from '@storeweave/kernel';
import type { JsonSchema7Type } from 'zod-to-json-schema';

/** 會員中心「購物金與等級」頁看到的樣子。 */
export interface ThemeAccountRewardsView {
  currency: string;
  balance: {
    availableCents: number;
    /** 已入帳但還沒生效。顧客看得到它才不會以為系統壞了。 */
    pendingCents: number;
    expiredCents: number;
    nextExpiry: { amountCents: number; expiresAt: Date } | null;
  };
  entries: {
    amountCents: number;
    /** 已經翻成人看得懂的來源說法。 */
    description: string;
    effectiveAt: Date;
    expiresAt: Date | null;
    createdAt: Date;
  }[];
  tier: {
    name: string;
    points: number;
    next: { name: string; remainingPoints: number } | null;
    /** 滾動期間的起點與長度。降級時要解釋得了為什麼。 */
    windowStartsAt: Date;
    windowMonths: number;
  };
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

/** 帳本的來源代碼對顧客沒有意義。客服補償的原因有寫就照實顯示。 */
function rewardDescription(entry: { source: string; reason: string | null }): string {
  if (entry.reason) return entry.reason;
  switch (entry.source) {
    case 'order-accrual': return '購物回饋';
    case 'redemption': return '結帳折抵';
    case 'reversal': return '訂單取消回沖';
    default: return '調整';
  }
}

/**
 * 幣別是店鋪層級的設定，不是每個請求都要查一次的資料——跟 loyalty 其他
 * 模組層 handler（如 `createGetCustomerLoyaltyHandler`）一樣，在模組組裝
 * 時就從 deps 決定，而不是加進 `PageResolveContext`。
 */
export function createLoyaltyPages(deps: { currency: string }) {
  return {
    rewards: definePage({
      id: 'commerce.loyalty.rewards',
      path: '/account/rewards',
      method: 'get',
      audience: 'customer',
      input: z.object({}),
      contract: {
        kind: 'storefront', request: 'none', input: jsonSchema([]), audience: 'customer',
        responses: [html(), html('platform-error'), redirect({ kind: 'server-constructed' })],
        cookieEffects: ['cart-notice-consume'],
      },
      resolve: async ctx => {
        const [rewards, tier] = await Promise.all([
          ctx.queries.execute<{
            balance: ThemeAccountRewardsView['balance'];
            entries: { amountCents: number; source: string; reason: string | null; effectiveAt: Date; expiresAt: Date | null; createdAt: Date }[];
          }>('commerce.loyalty.getMyRewards', {}, { actor: ctx.actor }),
          ctx.queries.execute<{
            current: { name: string };
            points: number;
            next: { tier: { name: string }; remainingPoints: number } | null;
            windowStartsAt: Date;
            windowMonths: number;
          }>('commerce.loyalty.getMyTier', {}, { actor: ctx.actor }),
        ]);

        return {
          kind: 'view',
          view: {
            currency: deps.currency,
            balance: rewards.balance,
            entries: rewards.entries.map(entry => ({
              amountCents: entry.amountCents,
              description: rewardDescription(entry),
              effectiveAt: entry.effectiveAt,
              expiresAt: entry.expiresAt,
              createdAt: entry.createdAt,
            })),
            tier: {
              name: tier.current.name,
              points: tier.points,
              next: tier.next ? { name: tier.next.tier.name, remainingPoints: tier.next.remainingPoints } : null,
              windowStartsAt: tier.windowStartsAt,
              windowMonths: tier.windowMonths,
            },
          },
        };
      },
    }),
  } as const;
}

export type LoyaltyPages = ReturnType<typeof createLoyaltyPages>;
