import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import {
  createPromotionInput,
  promotionDto,
  setPromotionStatusInput,
  updatePromotionInput,
  type PromotionDto,
} from './dto';
import { PromotionRepository, toPromotionDto } from './repository';

const repository = new PromotionRepository();

/** 規則的型別另存一欄，jsonb 只放該型別的參數——列表與索引才不必拆 json。 */
function splitRule(rule: PromotionDto['rule']): { ruleType: string; rule: Record<string, unknown> } {
  const { type, ...params } = rule;
  return { ruleType: type, rule: params };
}

export const createPromotionCommand = defineCommand({
  name: 'commerce.promotion.createPromotion',
  summary: '建立促銷活動',
  input: createPromotionInput,
  output: promotionDto,
  permission: 'promotion:write',
  idempotency: 'optional',
  audit: {
    action: 'promotion.created',
    resourceType: 'promotion',
    resourceId: (_i, o: PromotionDto) => o.id,
    redact: (i) => ({ name: i.name, ruleType: i.rule.type, priority: i.priority, stackable: i.stackable }),
  },
});

export const createPromotionHandler = async (
  input: z.infer<typeof createPromotionInput>,
  ctx: CommandContext,
): Promise<PromotionDto> => {
  const row = await repository.insert(ctx.tx, {
    id: randomUUID(),
    name: input.name,
    status: input.status,
    ...splitRule(input.rule),
    priority: input.priority,
    stackable: input.stackable,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  return toPromotionDto(row);
};

export const updatePromotionCommand = defineCommand({
  name: 'commerce.promotion.updatePromotion',
  summary: '編輯促銷活動',
  input: updatePromotionInput,
  output: promotionDto,
  permission: 'promotion:write',
  idempotency: 'optional',
  audit: { action: 'promotion.updated', resourceType: 'promotion', resourceId: (i) => i.id },
});

export const updatePromotionHandler = async (
  input: z.infer<typeof updatePromotionInput>,
  ctx: CommandContext,
): Promise<PromotionDto> => {
  const { id, rule, ...patch } = input;
  const changed = Object.entries({ ...patch, rule }).filter(([, v]) => v !== undefined);
  if (changed.length === 0) throw PlatformError.validation('No fields to update');

  const existing = await repository.findById(ctx.tx, id);
  if (!existing) throw PlatformError.notFound('Promotion', id);

  // 期間只改一半時，另一半仍要與資料庫裡的值比對，否則會存出永遠不生效的活動。
  const startsAt = patch.startsAt ?? existing.startsAt;
  const endsAt = patch.endsAt ?? existing.endsAt;
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
    throw PlatformError.validation('endsAt must be later than startsAt');
  }

  const row = await repository.update(ctx.tx, id, {
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.priority === undefined ? {} : { priority: patch.priority }),
    ...(patch.stackable === undefined ? {} : { stackable: patch.stackable }),
    ...(patch.startsAt === undefined ? {} : { startsAt: patch.startsAt }),
    ...(patch.endsAt === undefined ? {} : { endsAt: patch.endsAt }),
    ...(rule === undefined ? {} : splitRule(rule)),
    updatedAt: ctx.now,
  });
  if (!row) throw PlatformError.notFound('Promotion', id);
  return toPromotionDto(row);
};

export const setPromotionStatusCommand = defineCommand({
  name: 'commerce.promotion.setPromotionStatus',
  summary: '停用或重新啟用促銷活動',
  input: setPromotionStatusInput,
  output: promotionDto,
  permission: 'promotion:write',
  idempotency: 'optional',
  audit: {
    action: 'promotion.status-changed',
    resourceType: 'promotion',
    resourceId: (i) => i.id,
    redact: (i) => ({ status: i.status }),
  },
});

export const setPromotionStatusHandler = async (
  input: z.infer<typeof setPromotionStatusInput>,
  ctx: CommandContext,
): Promise<PromotionDto> => {
  const row = await repository.update(ctx.tx, input.id, { status: input.status, updatedAt: ctx.now });
  if (!row) throw PlatformError.notFound('Promotion', input.id);
  return toPromotionDto(row);
};
