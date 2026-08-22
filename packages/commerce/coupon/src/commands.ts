import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import type { NotificationProvider, ProviderRegistry } from '@storeweave/extension-sdk';
import { customerService } from '@storeweave/customer';
import { PromotionRepository } from '@storeweave/promotion';
import { birthdayMonthDaysFor, storeDateParts } from './birthday';
import {
  couponDto,
  createCouponInput,
  issueAutoCouponsInput,
  issueAutoCouponsOutput,
  issueBirthdayCouponsInput,
  issueBirthdayCouponsOutput,
  issueCouponsInput,
  issueCouponsOutput,
  setCouponStatusInput,
  type CouponDto,
} from './dto';
import { CouponRepository, toCouponDto } from './repository';
import { issueCouponTo } from './service';

const repository = new CouponRepository();
const promotions = new PromotionRepository();

export interface CouponModuleDeps {
  providers: ProviderRegistry;
  /** 「生日當天」是店鋪時區的當天，不是 UTC 的當天。 */
  timezone: string;
  /** 券的面額要說給顧客聽，因此需要幣別與地區格式。 */
  currency: string;
  locale: string;
}

export const createCouponCommand = defineCommand({
  name: 'commerce.coupon.createCoupon',
  summary: '建立一張券（共用碼或實發券）',
  input: createCouponInput,
  output: couponDto,
  permission: 'coupon:write',
  idempotency: 'required',
  audit: {
    action: 'coupon.created',
    resourceType: 'coupon',
    resourceId: (_i, o: CouponDto) => o.id,
    redact: (i) => ({ code: i.code, promotionId: i.promotionId, maxRedemptions: i.maxRedemptions }),
  },
});

export const createCouponHandler = async (
  input: z.infer<typeof createCouponInput>,
  ctx: CommandContext,
): Promise<CouponDto> => {
  await assertCouponOnlyPromotion(ctx, input.promotionId);
  const existing = await repository.findByCode(ctx.tx, input.code);
  // 重複的碼要明講。唯一索引也會擋，但那個錯誤訊息對經營者沒有意義。
  if (existing) throw PlatformError.conflict(`Coupon code ${input.code} already exists`);

  const row = await repository.insert(ctx.tx, {
    id: randomUUID(),
    code: input.code,
    promotionId: input.promotionId,
    status: 'issued',
    customerId: input.customerId ?? null,
    partnerCode: input.partnerCode ?? null,
    source: 'manual',
    batchId: null,
    issueKey: null,
    maxRedemptions: input.maxRedemptions ?? null,
    redeemedCount: 0,
    perCustomerLimit: input.perCustomerLimit,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  return toCouponDto(row);
};

/**
 * 券只能指向「需要券」的活動。
 *
 * 指向人人適用的活動時，那檔活動會被載入兩次而折扣套兩次——後台 UI 有擋，
 * 但 REST、MCP 與自動發券都繞得過去。UI 的過濾不是不變式。
 */
async function assertCouponOnlyPromotion(ctx: CommandContext, promotionId: string): Promise<void> {
  const promotion = await promotions.findById(ctx.tx, promotionId);
  if (!promotion) throw PlatformError.notFound('Promotion', promotionId);
  if (!promotion.requiresCoupon) {
    throw PlatformError.validation('Coupons may only point at promotions that require a coupon');
  }
}

export const setCouponStatusCommand = defineCommand({
  name: 'commerce.coupon.setCouponStatus',
  summary: '停用或恢復一張券',
  input: setCouponStatusInput,
  output: couponDto,
  permission: 'coupon:write',
  idempotency: 'required',
  audit: {
    action: 'coupon.status-set',
    resourceType: 'coupon',
    resourceId: (i) => i.id,
    redact: (i) => ({ status: i.status }),
  },
});

/**
 * 停用與恢復。**用掉的券不能被改回可用**——那等於免費再送一次，
 * 而且 `redeemedCount` 不會跟著回退。要還給顧客有 `reverseCouponForOrder` 這條正式路徑。
 */
export const setCouponStatusHandler = async (
  input: z.infer<typeof setCouponStatusInput>,
  ctx: CommandContext,
): Promise<CouponDto> => {
  const existing = await repository.findById(ctx.tx, input.id);
  if (!existing) throw PlatformError.notFound('Coupon', input.id);
  if (existing.status === 'used' || input.status === 'used') {
    throw PlatformError.validation('A used coupon can only change state by reversing its redemption');
  }

  const row = await repository.update(ctx.tx, input.id, { status: input.status, updatedAt: ctx.now });
  if (!row) throw PlatformError.notFound('Coupon', input.id);
  return toCouponDto(row);
};

export const issueCouponsCommand = defineCommand({
  name: 'commerce.coupon.issueCoupons',
  summary: '批次發券給會員',
  input: issueCouponsInput,
  output: issueCouponsOutput,
  permission: 'coupon:write',
  idempotency: 'required',
  audit: {
    action: 'coupon.issued',
    resourceType: 'coupon-batch',
    resourceId: (_i, o: { batchId: string }) => o.batchId,
    redact: (i) => ({ promotionId: i.promotionId, targeted: i.customerIds?.length ?? 'all' }),
  },
});

/**
 * 批次發券。每張券各自有碼與到期日，發放結果以 `batchId` 追得回來。
 *
 * 去重鍵是「這一批 × 這個人」：同一批重跑不會發第二張，但同一個人在
 * 不同批次可以各拿一張——那是經營者的意圖，不是錯誤。
 */
export const issueCouponsHandler = async (
  input: z.infer<typeof issueCouponsInput>,
  ctx: CommandContext,
): Promise<z.infer<typeof issueCouponsOutput>> => {
  await assertCouponOnlyPromotion(ctx, input.promotionId);
  const batchId = randomUUID();
  const customerIds = input.customerIds ?? await customerService.activeCustomerIds(ctx.tx);
  if (customerIds.length === 0) throw PlatformError.validation('No customers to issue to');

  const expiresAt = input.expiresInDays
    ? new Date(ctx.now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  let issued = 0;
  for (const customerId of customerIds) {
    const row = await issueCouponTo(ctx.tx, {
      promotionId: input.promotionId,
      customerId,
      now: ctx.now,
      source: 'manual',
      batchId,
      issueKey: `batch:${batchId}:${customerId}`,
      codePrefix: input.codePrefix,
      expiresAt,
      perCustomerLimit: input.perCustomerLimit,
    });
    if (row) issued += 1;
  }
  ctx.logger.info({ batchId, issued, targeted: customerIds.length }, 'issued coupon batch');
  return { batchId, issued, skipped: customerIds.length - issued };
};

export const issueAutoCouponsCommand = defineCommand({
  name: 'commerce.coupon.issueAutoCoupons',
  summary: '依觸發自動發券（註冊、生日）',
  input: issueAutoCouponsInput,
  output: issueAutoCouponsOutput,
  permission: 'coupon:write',
  idempotency: 'required',
  audit: {
    action: 'coupon.auto-issued',
    resourceType: 'customer',
    resourceId: (i) => i.customerId,
    redact: (i) => ({ trigger: i.trigger, occurrence: i.occurrence }),
  },
});

/**
 * 註冊與生日共用這一支：觸發不同，發放路徑相同（Spec 0004）。
 *
 * 去重鍵是「觸發 × 活動 × 人 × 場合」，撞上就不發。事件重投與排程重跑因此
 * 都是安全的——這比在呼叫端先查一次「他領過了嗎」可靠，那個判斷會輸給併發。
 */
async function issueAutoCouponsFor(
  deps: CouponModuleDeps,
  ctx: CommandContext,
  input: z.infer<typeof issueAutoCouponsInput>,
): Promise<string[]> {
  const active = await promotions.listAutoIssueAt(ctx.tx, input.trigger, ctx.now);
  const codes: string[] = [];

  for (const promotion of active) {
    const expiresAt = promotion.autoIssueValidDays
      ? new Date(ctx.now.getTime() + promotion.autoIssueValidDays * 24 * 60 * 60 * 1000)
      : null;
    const row = await issueCouponTo(ctx.tx, {
      promotionId: promotion.id,
      customerId: input.customerId,
      now: ctx.now,
      source: input.trigger,
      issueKey: `${input.trigger}:${promotion.id}:${input.customerId}:${input.occurrence}`,
      expiresAt,
    });
    if (row) codes.push(row.code);
  }

  if (codes.length > 0) await notify(deps, ctx, input, codes);
  return codes;
}

export function createIssueAutoCouponsHandler(deps: CouponModuleDeps) {
  return async (
    input: z.infer<typeof issueAutoCouponsInput>,
    ctx: CommandContext,
  ): Promise<z.infer<typeof issueAutoCouponsOutput>> => {
    const codes = await issueAutoCouponsFor(deps, ctx, input);
    return { issued: codes.length, codes };
  };
}

export const issueBirthdayCouponsCommand = defineCommand({
  name: 'commerce.coupon.issueBirthdayCoupons',
  summary: '發出今天的生日禮券',
  input: issueBirthdayCouponsInput,
  output: issueBirthdayCouponsOutput,
  permission: 'coupon:write',
  idempotency: 'required',
  audit: {
    action: 'coupon.birthday-issued',
    resourceType: 'coupon-batch',
    resourceId: () => 'birthday',
    redact: () => ({}),
  },
});

/**
 * 今天的壽星。切片邊界對齊 UTC（ADR 0016），但「生日當天」是店鋪時區的當天——
 * 這個換算必須由 handler 自己做。
 *
 * 同一個人同一年只會收到一次：去重鍵帶年份，重跑與跨切片都擋得住。
 */
export function createIssueBirthdayCouponsHandler(deps: CouponModuleDeps) {
  return async (
    input: z.infer<typeof issueBirthdayCouponsInput>,
    ctx: CommandContext,
  ): Promise<z.infer<typeof issueBirthdayCouponsOutput>> => {
    const at = input.on ?? ctx.now;
    const monthDays = birthdayMonthDaysFor(at, deps.timezone);
    const { year } = storeDateParts(at, deps.timezone);
    const customerIds = await customerService.customerIdsWithBirthdayOn(ctx.tx, monthDays);

    let issued = 0;
    for (const customerId of customerIds) {
      const codes = await issueAutoCouponsFor(deps, ctx, {
        trigger: 'birthday',
        customerId,
        occurrence: year,
      });
      issued += codes.length;
    }
    ctx.logger.info({ monthDays, customers: customerIds.length, issued }, 'issued birthday coupons');
    return { monthDays, customers: customerIds.length, issued };
  };
}

/**
 * 通知走 Provider。寄不出去不該讓發券回滾——券已經在他的帳號裡，
 * 而通知可以補寄；反過來把券吞掉才是真的損失。
 */
async function notify(
  deps: CouponModuleDeps,
  ctx: CommandContext,
  input: z.infer<typeof issueAutoCouponsInput>,
  codes: string[],
): Promise<void> {
  try {
    const customer = await customerService.contactFor(ctx.tx, input.customerId);
    if (!customer) return;
    const provider = deps.providers.get<NotificationProvider>('notification');
    await provider.send({
      template: `customer.coupon-${input.trigger}`,
      to: { email: customer.email, name: customer.displayName },
      variables: { codes, count: codes.length },
      reference: `coupon-${input.trigger}:${input.customerId}:${input.occurrence}`,
    });
  } catch (err) {
    ctx.logger.error({ error: (err as Error).message, customerId: input.customerId }, 'coupon notification failed');
  }
}
