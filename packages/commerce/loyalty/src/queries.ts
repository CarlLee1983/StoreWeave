import { z } from 'zod';
import { defineQuery, type QueryContext } from '@storeweave/contracts';
import { customerService } from '@storeweave/customer';
import { getMyRewardsInput, getMyRewardsOutput, outstandingRewardsOutput, rewardSettingsDto } from './dto';
import { LoyaltyRepository } from './repository';
import { rewardService } from './service';

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
