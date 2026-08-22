import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import { couponDto, createCouponInput, setCouponStatusInput, type CouponDto } from './dto';
import { CouponRepository, toCouponDto } from './repository';

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
    redact: (i) => ({ code: i.code, promotionId: i.promotionId }),
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
