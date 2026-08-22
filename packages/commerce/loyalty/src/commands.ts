import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import type { NotificationProvider, ProviderRegistry } from '@storeweave/extension-sdk';
import { customerService } from '@storeweave/customer';
import {
  adjustRewardsInput,
  notifyExpiringRewardsInput,
  notifyExpiringRewardsOutput, adjustTierPointsInput, listTiersOutput, recalculateTiersInput, recalculateTiersOutput,
  removeTierInput, rewardEntryDto, rewardSettingsDto, saveTierInput, tierDto, updateRewardSettingsInput,
} from './dto';
import { LoyaltyRepository } from './repository';
import { deriveRewardBalance } from './balance';
import { rewardService, tierService } from './service';

export interface LoyaltyModuleDeps {
  providers: ProviderRegistry;
  /** 金額要說得出幣別。後台硬編一個 'TWD' 只是在等第二個幣別的商店出現。 */
  currency: string;
}

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
    ...(input.expiryNoticeDays === undefined ? {} : { expiryNoticeDays: input.expiryNoticeDays }),
    updatedAt: ctx.now,
  });
  return {
    accrualBasisPoints: row.accrualBasisPoints,
    effectiveAfterDays: row.effectiveAfterDays,
    expiresAfterDays: row.expiresAfterDays,
    expiryNoticeDays: row.expiryNoticeDays,
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
  // 手動調整沒有去重鍵，因此 insert 不會回 null；真的回了就是資料層壞了，要出聲。
  if (!row) throw PlatformError.internal('Manual reward adjustment was not written');
  return {
    id: row.id,
    amountCents: row.amountCents,
    source: row.source,
    reference: row.reference,
    effectiveAt: row.effectiveAt,
    expiresAt: row.expiresAt,
    reason: row.reason,
    createdAt: row.createdAt,
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
  // 還有活動指名這一級的話，刪掉它會讓那檔活動安靜地永遠不套用。
  const referencing = await promotionsReferencingTier(ctx, input.name);
  if (referencing.length > 0) {
    throw PlatformError.validation(
      `Tier "${input.name}" is still used by ${referencing.length} promotion(s); update them first`,
    );
  }
  await repository.deleteTier(ctx.tx, input.name);
  const items = await tierService.definitions(ctx.tx);
  // 保底那一級不能消失：沒有門檻為零的等級，新會員不屬於任何等級。
  if (!items.some((tier) => tier.thresholdPoints === 0)) {
    throw PlatformError.validation('At least one tier with a zero threshold must remain');
  }
  return { items };
};

/** 哪些活動限定了這一級。刪除等級之前要問一次。 */
async function promotionsReferencingTier(ctx: CommandContext, name: string): Promise<string[]> {
  const rows = await ctx.tx.execute<{ id: string }>(
    sql`SELECT id FROM promotion_promotions WHERE ${name} = ANY(tier_names)`,
  );
  return rows.rows.map((row) => row.id);
}

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
  const customerIds = await repository.staleTierCustomerIds(ctx.tx, input.limit);

  let changed = 0;
  let upgraded = 0;
  let downgraded = 0;
  let initialised = 0;
  const definitions = await tierService.definitions(ctx.tx);
  const rank = new Map(definitions.map((tier, index) => [tier.name, index]));

  for (const customerId of customerIds) {
    const result = await tierService.recalculate(ctx.tx, customerId, at);
    if (!result.changed) continue;
    changed += 1;
    // 第一次算到這位顧客不是升級，是建立快取；舊等級被 removeTier 刪掉時也比不出升降。
    // 兩者都當成升級的話，統計會虛胖到看不出真正的變動。
    if (result.from === null) {
      initialised += 1;
      continue;
    }
    const before = rank.get(result.from);
    if (before === undefined) continue;
    if ((rank.get(result.to) ?? -1) > before) upgraded += 1;
    else downgraded += 1;
  }
  ctx.logger.info(
    { evaluated: customerIds.length, changed, upgraded, downgraded, initialised },
    'recalculated member tiers',
  );
  return { evaluated: customerIds.length, changed, upgraded, downgraded };
};

export const notifyExpiringRewardsCommand = defineCommand({
  name: 'commerce.loyalty.notifyExpiringRewards',
  summary: '通知購物金即將到期的顧客',
  input: notifyExpiringRewardsInput,
  output: notifyExpiringRewardsOutput,
  permission: 'customers:manage',
  idempotency: 'required',
  audit: {
    action: 'loyalty.expiry-notified',
    resourceType: 'loyalty-settings',
    resourceId: () => 'expiry-notice',
    redact: () => ({}),
  },
});

/**
 * 到期通知。
 *
 * 只通知「還有剩」的批次：餘額被用完的人不該收到一封說他要失去什麼的信。
 * 剩多少要由帳本推導——批次的原始金額不等於它現在還剩多少。
 *
 * 同一批只通知一次，靠自己的紀錄表而不是 Provider 的冪等：
 * 「這一批通知過了嗎」是領域問題，換一個 Provider 不該讓顧客被通知兩次。
 */
export function createNotifyExpiringRewardsHandler(deps: LoyaltyModuleDeps) {
  return async (
    input: z.infer<typeof notifyExpiringRewardsInput>,
    ctx: CommandContext,
  ): Promise<z.infer<typeof notifyExpiringRewardsOutput>> => {
    const at = input.at ?? ctx.now;
    const settings = await repository.settings(ctx.tx);
    const to = new Date(at.getTime() + settings.expiryNoticeDays * DAY_MS);

    const batches = await repository.expiringBatches(ctx.tx, { from: at, to });
    const alreadyNotified = await repository.notifiedEntryIds(ctx.tx, batches.map((row) => row.id));

    let notified = 0;
    let skipped = 0;

    for (const batch of batches) {
      if (alreadyNotified.has(batch.id)) {
        skipped += 1;
        continue;
      }
      // 剩多少要由帳本推導：這一批可能早就被花掉了。
      const entries = await repository.rewardEntriesFor(ctx.tx, batch.customerId);
      const balance = deriveRewardBalance(
        entries.map((row) => ({
          id: row.id, amountCents: row.amountCents, source: row.source, effectiveAt: row.effectiveAt,
          expiresAt: row.expiresAt, createdAt: row.createdAt,
        })),
        at,
      );
      const remaining = balance.batches.find((candidate) => candidate.id === batch.id)?.remainingCents ?? 0;
      if (remaining <= 0) {
        skipped += 1;
        continue;
      }

      const claimed = await repository.markNotified(ctx.tx, {
        entryId: batch.id,
        customerId: batch.customerId,
        notifiedAt: ctx.now,
      });
      if (!claimed) {
        skipped += 1;
        continue;
      }
      const sent = await sendExpiryNotice(deps, ctx, {
        customerId: batch.customerId,
        entryId: batch.id,
        amountCents: remaining,
        expiresAt: batch.expiresAt!,
      });
      if (!sent) {
        // 先佔位是為了擋併發；寄不出去就要放掉，否則「下一輪還會再遇到它」是假的。
        await repository.clearNotified(ctx.tx, batch.id);
        skipped += 1;
        continue;
      }
      notified += 1;
    }

    ctx.logger.info({ notified, skipped, until: to }, 'notified expiring rewards');
    return { notified, skipped };
  };
}

/**
 * 寄不出去不讓整批失敗，但要回報成敗——呼叫端據此決定要不要放掉佔位。
 * 靜靜吞掉例外又回報「已寄出」，等於用一張表把「永遠不通知」記成「通知過了」。
 */
async function sendExpiryNotice(
  deps: LoyaltyModuleDeps,
  ctx: CommandContext,
  input: { customerId: string; entryId: string; amountCents: number; expiresAt: Date },
): Promise<boolean> {
  try {
    const customer = await customerService.contactFor(ctx.tx, input.customerId);
    // 收件人不存在不是暫時性失敗，重試也沒用——佔位留著。
    if (!customer) return true;
    const provider = deps.providers.get<NotificationProvider>('notification');
    const result = await provider.send({
      template: 'customer.reward-expiring',
      to: { email: customer.email, name: customer.displayName },
      variables: { amountCents: input.amountCents, expiresAt: input.expiresAt.toISOString() },
      reference: `reward-expiry:${input.entryId}`,
    });
    if (result.status !== 'sent') {
      ctx.logger.warn({ customerId: input.customerId, message: result.message }, 'reward expiry notice not delivered');
      return false;
    }
    return true;
  } catch (err) {
    ctx.logger.error({ error: (err as Error).message, customerId: input.customerId }, 'reward expiry notice failed');
    return false;
  }
}
