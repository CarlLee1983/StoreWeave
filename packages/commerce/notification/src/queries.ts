import { z } from 'zod';
import { PlatformError, defineQuery, type QueryContext } from '@storeweave/contracts';
import { lifecycleDeliveryDto, listLifecycleDeliveriesInput, listLifecycleDeliveriesOutput } from './dto';
import { NotificationRepository, toLifecycleDeliveryDto } from './repository';

const repository = new NotificationRepository();

export const getLifecycleDeliveryQuery = defineQuery({
  name: 'commerce.notification.getLifecycleDelivery', summary: '讀取一筆通知投遞證據',
  input: z.object({ id: z.string().uuid() }).strict(), output: lifecycleDeliveryDto, permission: 'notification:system-write',
});

export const getLifecycleDeliveryHandler = async (input: { id: string }, ctx: QueryContext) => {
  const row = await repository.findById(ctx.db, input.id);
  if (!row) throw PlatformError.notFound('LifecycleDelivery', input.id);
  return toLifecycleDeliveryDto(row);
};

export const listLifecycleDeliveriesQuery = defineQuery({
  name: 'commerce.notification.listLifecycleDeliveries', summary: '列出訂單生命週期通知投遞證據',
  input: listLifecycleDeliveriesInput, output: listLifecycleDeliveriesOutput, permission: 'notification:read',
});

export const listLifecycleDeliveriesHandler = async (input: z.infer<typeof listLifecycleDeliveriesInput>, ctx: QueryContext) => {
  const result = await repository.list(ctx.db, input);
  return { items: result.items.map(toLifecycleDeliveryDto), total: result.total };
};
