import { z } from 'zod';
import { PlatformError, defineQuery, type QueryContext } from '@storeweave/contracts';
import { maskEmailsIn, maskRecipient, type NotificationsPort } from '@storeweave/notifications';
import { lifecycleDeliveryDto, listLifecycleDeliveriesInput, listLifecycleDeliveriesOutput, type LifecycleDeliverySummaryDto } from './dto';
import { NotificationRepository, toLifecycleDeliveryDto } from './repository';

export { maskEmailsIn, maskRecipient };

const repository = new NotificationRepository();

export const getLifecycleDeliveryQuery = defineQuery({
  name: 'commerce.notification.getLifecycleDelivery', summary: '讀取一筆通知投遞證據',
  input: z.object({ id: z.string().uuid() }).strict(), output: lifecycleDeliveryDto, permission: 'notification:system-write',
});

export const getLifecycleDeliveryHandler = async (input: { id: string }, ctx: QueryContext) => {
  // 權限鍵擋不掉 admin 的 `*`。完整紀錄帶顧客地址與 variables，只有背景工作需要它。
  if (ctx.actor.type !== 'system') throw PlatformError.forbidden('Only notification workers may read the full delivery record');
  const row = await repository.findById(ctx.db, input.id);
  if (!row) throw PlatformError.notFound('LifecycleDelivery', input.id);
  return toLifecycleDeliveryDto(row);
};

export const listLifecycleDeliveriesQuery = defineQuery({
  name: 'commerce.notification.listLifecycleDeliveries', summary: '列出訂單生命週期通知投遞證據',
  input: listLifecycleDeliveriesInput, output: listLifecycleDeliveriesOutput, permission: 'notification:read',
});

/**
 * 投遞狀態向 base 通知能力要，不自己存一份。B07 之前建立的紀錄沒有對應的 base 通知，
 * 讀回來的就是它自己當時留下的欄位——舊紀錄照樣看得到，只是不會再更新。
 */
export function createListLifecycleDeliveriesHandler(notifications: () => NotificationsPort) {
  return async (input: z.infer<typeof listLifecycleDeliveriesInput>, ctx: QueryContext) => {
    const result = await repository.list(ctx.db, { ...input, status: undefined });
    const evidence = await notifications().evidenceByReference(result.items.map(row => row.reference));
    const items: LifecycleDeliverySummaryDto[] = result.items.map((row) => {
      const { recipientEmail, variables: _variables, ...rest } = toLifecycleDeliveryDto(row);
      const delivery = evidence.get(row.reference)?.[0];
      return {
        ...rest,
        status: delivery?.status ?? rest.status,
        providerRef: delivery?.externalRef ?? rest.providerRef,
        attempts: delivery?.attempts ?? rest.attempts,
        lastError: maskEmailsIn(delivery?.lastError ?? rest.lastError),
        sentAt: delivery?.sentAt ?? rest.sentAt,
        recipientMasked: maskRecipient(recipientEmail),
      };
    });
    // 狀態是投遞端的事實，因此篩選要在合併之後做，否則篩到的是這張表的舊值。
    const filtered = input.status ? items.filter(item => item.status === input.status) : items;
    return { items: filtered, total: input.status ? filtered.length : result.total };
  };
}
