import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineCommand, type CommandContext } from '@storeweave/contracts';
import { adjustRewardsInput, rewardEntryDto, rewardSettingsDto, updateRewardSettingsInput } from './dto';
import { LoyaltyRepository } from './repository';

const repository = new LoyaltyRepository();

const DAY_MS = 24 * 60 * 60 * 1000;

export const updateRewardSettingsCommand = defineCommand({
  name: 'commerce.loyalty.updateRewardSettings',
  summary: '設定購物金的累積比例與生效天數',
  input: updateRewardSettingsInput,
  output: rewardSettingsDto,
  permission: 'promotion:write',
  idempotency: 'optional',
  audit: {
    action: 'loyalty.settings-updated',
    resourceType: 'loyalty-settings',
    resourceId: () => 'singleton',
    redact: (i) => ({ ...i }),
  },
});

export const updateRewardSettingsHandler = async (
  input: z.infer<typeof updateRewardSettingsInput>,
  ctx: CommandContext,
) => {
  const row = await repository.updateSettings(ctx.tx, {
    ...(input.accrualBasisPoints === undefined ? {} : { accrualBasisPoints: input.accrualBasisPoints }),
    ...(input.effectiveAfterDays === undefined ? {} : { effectiveAfterDays: input.effectiveAfterDays }),
    ...(input.expiresAfterDays === undefined ? {} : { expiresAfterDays: input.expiresAfterDays }),
    updatedAt: ctx.now,
  });
  return {
    accrualBasisPoints: row.accrualBasisPoints,
    effectiveAfterDays: row.effectiveAfterDays,
    expiresAfterDays: row.expiresAfterDays,
    updatedAt: row.updatedAt,
  };
};

export const adjustRewardsCommand = defineCommand({
  name: 'commerce.loyalty.adjustRewards',
  summary: '手動調整某位會員的購物金',
  input: adjustRewardsInput,
  output: rewardEntryDto,
  permission: 'customers:manage',
  idempotency: 'required',
  audit: {
    action: 'loyalty.rewards-adjusted',
    resourceType: 'customer',
    resourceId: (i) => i.customerId,
    // 原因要進稽核紀錄：這是客服補償的正式管道，事後查得到帳才有意義。
    redact: (i) => ({ amountCents: i.amountCents, reason: i.reason }),
  },
});

/**
 * 客服補償的正式管道。每一筆都是帶操作者與原因的帳本分錄——
 * 不是把餘額改掉，因為根本沒有餘額欄位可以改。
 */
export const adjustRewardsHandler = async (
  input: z.infer<typeof adjustRewardsInput>,
  ctx: CommandContext,
) => {
  const settings = await repository.settings(ctx.tx);
  const days = input.expiresInDays === undefined ? settings.expiresAfterDays : input.expiresInDays;
  const row = await repository.addRewardEntry(ctx.tx, {
    id: randomUUID(),
    customerId: input.customerId,
    amountCents: input.amountCents,
    source: 'manual',
    // 手動調整沒有去重鍵：同一位客服補兩次是兩筆，那是他的意圖。
    reference: null,
    // 補償立刻可用：讓顧客等七天才拿得到補償，等於補償了個寂寞。
    effectiveAt: ctx.now,
    expiresAt: input.amountCents > 0 && days !== null ? new Date(ctx.now.getTime() + days * DAY_MS) : null,
    actorId: ctx.actor.id,
    reason: input.reason,
    createdAt: ctx.now,
  });
  return {
    id: row!.id,
    amountCents: row!.amountCents,
    source: row!.source,
    reference: row!.reference,
    effectiveAt: row!.effectiveAt,
    expiresAt: row!.expiresAt,
    reason: row!.reason,
    createdAt: row!.createdAt,
  };
};
