import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import {
  adjustRewardsInput, adjustTierPointsInput, listTiersOutput, recalculateTiersInput, recalculateTiersOutput,
  removeTierInput, rewardEntryDto, rewardSettingsDto, saveTierInput, tierDto, updateRewardSettingsInput,
} from './dto';
import { LoyaltyRepository } from './repository';
import { tierService } from './service';

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

export const saveTierCommand = defineCommand({
  name: 'commerce.loyalty.saveTier',
  summary: '新增或修改一個會員等級',
  input: saveTierInput,
  output: tierDto,
  permission: 'promotion:write',
  idempotency: 'optional',
  audit: {
    action: 'loyalty.tier-saved',
    resourceType: 'loyalty-tier',
    resourceId: (i) => i.name,
    redact: (i) => ({ ...i }),
  },
});

/** 名稱是等級的識別：同名就是修改，不是再開一級。 */
export const saveTierHandler = async (input: z.infer<typeof saveTierInput>, ctx: CommandContext) => {
  const row = await repository.upsertTier(ctx.tx, {
    id: randomUUID(),
    name: input.name,
    thresholdPoints: input.thresholdPoints,
    multiplierBasisPoints: input.multiplierBasisPoints,
    updatedAt: ctx.now,
  });
  return {
    name: row.name,
    thresholdPoints: row.thresholdPoints,
    multiplierBasisPoints: row.multiplierBasisPoints,
  };
};

export const removeTierCommand = defineCommand({
  name: 'commerce.loyalty.removeTier',
  summary: '移除一個會員等級',
  input: removeTierInput,
  output: listTiersOutput,
  permission: 'promotion:write',
  idempotency: 'optional',
  audit: {
    action: 'loyalty.tier-removed',
    resourceType: 'loyalty-tier',
    resourceId: (i) => i.name,
    redact: () => ({}),
  },
});

export const removeTierHandler = async (input: z.infer<typeof removeTierInput>, ctx: CommandContext) => {
  await repository.deleteTier(ctx.tx, input.name);
  const items = await tierService.definitions(ctx.tx);
  // 保底那一級不能消失：沒有門檻為零的等級，新會員不屬於任何等級。
  if (!items.some((tier) => tier.thresholdPoints === 0)) {
    throw PlatformError.validation('At least one tier with a zero threshold must remain');
  }
  return { items };
};

export const adjustTierPointsCommand = defineCommand({
  name: 'commerce.loyalty.adjustTierPoints',
  summary: '手動調整某位會員的等級積分',
  input: adjustTierPointsInput,
  output: z.object({ points: z.number().int() }),
  permission: 'customers:manage',
  idempotency: 'required',
  audit: {
    action: 'loyalty.tier-points-adjusted',
    resourceType: 'customer',
    resourceId: (i) => i.customerId,
    redact: (i) => ({ points: i.points, reason: i.reason }),
  },
});

export const adjustTierPointsHandler = async (
  input: z.infer<typeof adjustTierPointsInput>,
  ctx: CommandContext,
) => {
  await repository.addTierEntry(ctx.tx, {
    id: randomUUID(),
    customerId: input.customerId,
    points: input.points,
    source: 'manual',
    reference: null,
    earnedAt: ctx.now,
    actorId: ctx.actor.id,
    reason: input.reason,
    createdAt: ctx.now,
  });
  // 調完立刻重算：讓客服看得到結果，而不是等下一次排程。
  const result = await tierService.recalculate(ctx.tx, input.customerId, ctx.now);
  return { points: result.points };
};

export const recalculateTiersCommand = defineCommand({
  name: 'commerce.loyalty.recalculateTiers',
  summary: '依滾動期間重算會員等級',
  input: recalculateTiersInput,
  output: recalculateTiersOutput,
  permission: 'customers:manage',
  idempotency: 'required',
  audit: {
    action: 'loyalty.tiers-recalculated',
    resourceType: 'loyalty-tier',
    resourceId: () => 'all',
    redact: () => ({}),
  },
});

/**
 * 重算所有有積分紀錄的顧客。它算的是帳本而不是累加，因此同一段期間
 * 重複執行的結果相同——升級與降級都由「現在的滾動期間內有多少積分」決定。
 */
export const recalculateTiersHandler = async (
  input: z.infer<typeof recalculateTiersInput>,
  ctx: CommandContext,
) => {
  const at = input.at ?? ctx.now;
  const customerIds = (await repository.customersWithTierPoints(ctx.tx)).slice(0, input.limit);

  let changed = 0;
  let upgraded = 0;
  let downgraded = 0;
  const definitions = await tierService.definitions(ctx.tx);
  const rank = new Map(definitions.map((tier, index) => [tier.name, index]));

  for (const customerId of customerIds) {
    const result = await tierService.recalculate(ctx.tx, customerId, at);
    if (!result.changed) continue;
    changed += 1;
    const before = result.from === null ? 0 : rank.get(result.from) ?? 0;
    if ((rank.get(result.to) ?? 0) > before) upgraded += 1;
    else downgraded += 1;
  }
  ctx.logger.info({ evaluated: customerIds.length, changed, upgraded, downgraded }, 'recalculated member tiers');
  return { evaluated: customerIds.length, changed, upgraded, downgraded };
};
