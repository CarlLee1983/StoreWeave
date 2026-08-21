import { createHash } from 'node:crypto';
import type {
  ExtensionContext,
  ExtensionStore,
  NotificationMessage,
  NotificationProvider,
  NotificationSendResult,
} from '@storeweave/extension-sdk';
import type { MockNotificationConfig } from './config';

/** Provider id 是契約的一部分，必須與 manifest.registeredProviders 一致。 */
export const MOCK_NOTIFICATION_PROVIDER_ID = 'mock-notification';

const SENT_PREFIX = 'sent:';

export interface SentNotification {
  reference: string;
  template: string;
  to: { email: string; name?: string };
  variables: Record<string, unknown> | null;
  locale: string | null;
  providerRef: string;
  sentAt: string;
}

/**
 * 開發與測試用的通知實作：不連外，把寄出的內容留在 Extension 自己的儲存裡。
 * 與 mock-payment 同樣示範 Provider Contract 的冪等要求：同一個 reference
 * 重送不會產生第二封信。
 */
export function createMockNotificationProvider(
  ctx: ExtensionContext<MockNotificationConfig>,
): NotificationProvider {
  return {
    id: MOCK_NOTIFICATION_PROVIDER_ID,
    kind: 'notification',

    async send(message: NotificationMessage): Promise<NotificationSendResult> {
      const key = `${SENT_PREFIX}${message.reference}`;
      const existing = await ctx.store.get<SentNotification>(key);
      if (existing) {
        ctx.logger.info({ reference: message.reference }, 'replaying existing notification');
        return { status: 'sent', providerRef: existing.providerRef, message: 'replayed' };
      }

      const providerRef = `mock_${createHash('sha256').update(message.reference).digest('hex').slice(0, 20)}`;
      if (!ctx.config.deliver) {
        // 失敗不留紀錄，之後重試才有意義。
        return { status: 'failed', providerRef, message: 'delivery disabled by mock notification configuration' };
      }

      const record: SentNotification = {
        reference: message.reference,
        template: message.template,
        to: message.to.name === undefined ? { email: message.to.email } : { email: message.to.email, name: message.to.name },
        variables: message.variables ?? null,
        locale: message.locale ?? null,
        providerRef,
        sentAt: ctx.now().toISOString(),
      };
      await ctx.store.set(key, record);
      ctx.logger.info({ reference: message.reference, template: message.template }, 'notification sent');

      return { status: 'sent', providerRef };
    },

    async healthCheck() {
      return { ok: true, message: ctx.config.deliver ? 'delivering notifications' : 'dropping all notifications' };
    },
  };
}

/** 測試用：讀出這個 Extension 寄過的所有通知，依寄出時間排序。 */
export async function listSentNotifications(store: ExtensionStore): Promise<SentNotification[]> {
  const entries = await store.list<SentNotification>(SENT_PREFIX);
  return entries
    .map((entry) => entry.value)
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.reference.localeCompare(b.reference));
}
