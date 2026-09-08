import { z } from 'zod';
import { PermanentJobError, type JobHandler } from '@storeweave/jobs';
import type { NotificationProvider, ProviderRegistry } from '@storeweave/extension-sdk';
import type { LifecycleDeliveryDto } from './dto';

export const lifecycleNotificationJobPayload = z.object({ deliveryId: z.string().uuid() }).strict();
/**
 * This handler is invoked by Worker after it has claimed the job.  Worker
 * deliberately runs handlers outside a database transaction, so provider I/O
 * cannot hold locks on the commerce state that caused the lifecycle event.
 */
export function createLifecycleNotificationJob(providers: ProviderRegistry): JobHandler {
  return async (raw, ctx) => {
    const { deliveryId } = lifecycleNotificationJobPayload.parse(raw);
    if (!ctx.executeQuery || !ctx.executeCommand) throw new PermanentJobError('Lifecycle notification job lacks core bus access');
    const delivery = await ctx.executeQuery('commerce.notification.getLifecycleDelivery', { id: deliveryId }) as LifecycleDeliveryDto;
    // A previous attempt may have succeeded just before its worker crashed.
    if (delivery.status === 'sent') return;
    const provider = providers.get<NotificationProvider>('notification');
    const result = await provider.send({
      template: delivery.template,
      to: { email: delivery.recipientEmail },
      variables: delivery.variables,
      reference: delivery.reference,
    });
    if (result.status === 'sent') {
      await ctx.executeCommand('commerce.notification.recordLifecycleDelivery', {
        id: delivery.id, status: 'sent', providerRef: result.providerRef,
      }, `notification:result:${delivery.id}:sent:${result.providerRef}`);
      return;
    }
    // The failure fact commits before this throw returns control to JobQueue,
    // which is what makes retries observable without rolling back Order/Shipment.
    await ctx.executeCommand('commerce.notification.recordLifecycleDelivery', {
      id: delivery.id, status: 'failed', providerRef: result.providerRef,
      error: result.message ?? 'Notification provider reported delivery failure',
    }, `notification:result:${delivery.id}:failed:${ctx.attempt}`);
    throw new Error(result.message ?? `Notification provider failed for ${delivery.id}`);
  };
}
