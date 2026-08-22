import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import { customerService } from '@storeweave/customer';
import {
  couponDto,
  createCouponInput,
  issueCouponsInput,
  issueCouponsOutput,
  setCouponStatusInput,
  type CouponDto,
} from './dto';
import { CouponRepository, toCouponDto } from './repository';
import { issueCouponTo } from './service';

const repository = new CouponRepository();

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

export const setCouponStatusHandler = async (
  input: z.infer<typeof setCouponStatusInput>,
  ctx: CommandContext,
): Promise<CouponDto> => {
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
