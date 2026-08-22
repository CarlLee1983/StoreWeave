import { z } from 'zod';
import { defineQuery, type QueryContext } from '@storeweave/contracts';
import { customerService } from '@storeweave/customer';
import {
  customerLoyaltyInput, customerLoyaltyOutput,
  getMyRewardsInput, getMyRewardsOutput, listTiersOutput, myTierOutput,
  outstandingRewardsOutput, rewardSettingsDto,
} from './dto';
import { LoyaltyRepository } from './repository';
import { rewardService, tierService } from './service';
import { TIER_WINDOW_MONTHS } from './tier';

const repository = new LoyaltyRepository();

export const getMyRewardsQuery = defineQuery({
  name: 'commerce.loyalty.getMyRewards',
  summary: '我的購物金餘額與明細',
  input: getMyRewardsInput,
  output: getMyRewardsOutput,
  // 範圍限縮在 handler：這支只回自己的帳，永遠不吃呼叫端給的顧客識別。
  permission: 'customer:read',
});

export const getMyRewardsHandler = async (input: z.infer<typeof getMyRewardsInput>, ctx: QueryContext) => {
  const me = await customerService.requireByActor(ctx.db, ctx.actor);
  const rows = await repository.rewardEntriesFor(ctx.db, me.customerId);
  const balance = await rewardService.balanceFor(ctx.db, me.customerId, ctx.now);
  const soonest = balance.batches.find((batch) => batch.expiresAt !== null);

  return {
    balance: {
      availableCents: balance.availableCents,
      pendingCents: balance.pendingCents,
      expiredCents: balance.expiredCents,
      nextExpiry: soonest ? { amountCents: soonest.remainingCents, expiresAt: soonest.expiresAt! } : null,
    },
    // 明細由新到舊：顧客找的是「最近發生了什麼」。
    entries: [...rows].reverse().slice(0, input.limit).map((row) => ({
      id: row.id,
      amountCents: row.amountCents,
      source: row.source,
      reference: row.reference,
      effectiveAt: row.effectiveAt,
      expiresAt: row.expiresAt,
      reason: row.reason,
      createdAt: row.createdAt,
    })),
  };
};

export const getRewardSettingsQuery = defineQuery({
  name: 'commerce.loyalty.getRewardSettings',
  summary: '購物金的累積規則',
  input: z.object({}).strict(),
  output: rewardSettingsDto,
  permission: 'promotion:read',
});

export const getRewardSettingsHandler = async (_input: unknown, ctx: QueryContext) => {
  const row = await repository.settings(ctx.db);
  return {
    accrualBasisPoints: row.accrualBasisPoints,
    effectiveAfterDays: row.effectiveAfterDays,
    expiresAfterDays: row.expiresAfterDays,
    expiryNoticeDays: row.expiryNoticeDays,
    updatedAt: row.updatedAt,
  };
};

export const outstandingRewardsQuery = defineQuery({
  name: 'commerce.loyalty.outstandingRewards',
  summary: '流通在外的購物金總額',
  input: z.object({}).strict(),
  output: outstandingRewardsOutput,
  permission: 'analytics:read',
});

export const outstandingRewardsHandler = async (_input: unknown, ctx: QueryContext) =>
  repository.outstandingRewards(ctx.db, ctx.now);

export const getMyTierQuery = defineQuery({
  name: 'commerce.loyalty.getMyTier',
  summary: '我的會員等級與距離下一級還差多少',
  input: z.object({}).strict(),
  output: myTierOutput,
  // 範圍限縮在 handler：這支只回自己的等級。
  permission: 'customer:read',
});

export const getMyTierHandler = async (_input: unknown, ctx: QueryContext) => {
  const me = await customerService.requireByActor(ctx.db, ctx.actor);
  const status = await tierService.statusFor(ctx.db, me.customerId, ctx.now);
  return { ...status, windowMonths: TIER_WINDOW_MONTHS };
};

export const listTiersQuery = defineQuery({
  name: 'commerce.loyalty.listTiers',
  summary: '等級的門檻與名稱',
  input: z.object({}).strict(),
  output: listTiersOutput,
  // 等級是公開資訊：顧客要看得到「下一級有什麼」才有努力的方向。
  permission: 'catalog:read',
});

export const listTiersHandler = async (_input: unknown, ctx: QueryContext) => ({
  items: await tierService.definitions(ctx.db),
});

export const getCustomerLoyaltyQuery = defineQuery({
  name: 'commerce.loyalty.getCustomerLoyalty',
  summary: '後台：某位會員的購物金與等級',
  input: customerLoyaltyInput,
  output: customerLoyaltyOutput,
  permission: 'customers:manage',
});

/** 客服在處理客訴時要看得到「他現在有多少、怎麼來的」，否則補償只能用猜的。 */
export const getCustomerLoyaltyHandler = async (
  input: z.infer<typeof customerLoyaltyInput>,
  ctx: QueryContext,
) => {
  const balance = await rewardService.balanceFor(ctx.db, input.customerId, ctx.now);
  const status = await tierService.statusFor(ctx.db, input.customerId, ctx.now);
  const rows = await repository.rewardEntriesFor(ctx.db, input.customerId);
  const soonest = balance.batches.find((batch) => batch.expiresAt !== null);

  return {
    balance: {
      availableCents: balance.availableCents,
      pendingCents: balance.pendingCents,
      expiredCents: balance.expiredCents,
      nextExpiry: soonest ? { amountCents: soonest.remainingCents, expiresAt: soonest.expiresAt! } : null,
    },
    tierName: status.current.name,
    tierPoints: status.points,
    entries: [...rows].reverse().slice(0, 50).map((row) => ({
      id: row.id,
      amountCents: row.amountCents,
      source: row.source,
      reference: row.reference,
      effectiveAt: row.effectiveAt,
      expiresAt: row.expiresAt,
      reason: row.reason,
      createdAt: row.createdAt,
    })),
  };
};
