import { z } from 'zod';
import { PlatformError, defineQuery, type QueryContext } from '@storeweave/contracts';
import { lifecycleDeliveryDto, listLifecycleDeliveriesInput, listLifecycleDeliveriesOutput, type LifecycleDeliverySummaryDto } from './dto';
import { NotificationRepository, toLifecycleDeliveryDto } from './repository';

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
 * `a***@example.com`。留得下網域是為了看得出退信是不是集中在某一家。
 *
 * 星號數量固定，不跟著本地端長度走——長度本身就是線索，配上網域往往足以把人縮到幾個。
 * 單字元本地端整個遮掉：只有一個字元時，留下首字等於沒有遮。
 */
const MASK = '***';
export function maskRecipient(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return MASK;
  const local = [...email.slice(0, at)];
  const domain = email.slice(at + 1);
  if (local.length <= 1) return `${MASK}@${domain}`;
  return `${local[0]}${MASK}@${domain}`;
}

/** provider 的退信訊息慣例會夾帶完整地址，隔壁欄位遮了這裡不遮等於沒遮。 */
export function maskEmailsIn(message: string | null): string | null {
  return message === null ? null : message.replace(/[^\s<>@]+@[^\s<>@,;]+/g, (match) => maskRecipient(match));
}

export const listLifecycleDeliveriesHandler = async (input: z.infer<typeof listLifecycleDeliveriesInput>, ctx: QueryContext) => {
  const result = await repository.list(ctx.db, input);
  const items: LifecycleDeliverySummaryDto[] = result.items.map((row) => {
    const { recipientEmail, variables: _variables, ...rest } = toLifecycleDeliveryDto(row);
    return { ...rest, lastError: maskEmailsIn(rest.lastError), recipientMasked: maskRecipient(recipientEmail) };
  });
  return { items, total: result.total };
};
