import { defineExtension } from '@storeweave/extension-sdk';
import { DEMO_ERP_API_KEY, PUSH_ORDER_JOB, demoErpConfig, type DemoErpConfig } from './config';
import { createDemoErpProvider } from './erp-client';
import {
  createListDeliveriesHandler, createOrderPaidHandler, createPushOrderJob, createResendHandler,
  listDeliveriesQuery, resendOrderCommand,
} from './handlers';
import type { DeliveryRecord } from './state';

export const demoErpExtension = defineExtension<DemoErpConfig>({
  manifest: {
    id: 'demo-erp',
    name: 'Demo ERP Integration',
    version: '1.0.0',
    platformVersion: '^1.0.0',
    description: '訂閱 commerce.order.paid.v1，轉成 ERP 單據後以背景工作可靠送出。',
    permissions: ['order:read', 'erp:read', 'erp:write'],
    declaredPermissions: [
      { key: 'erp:read', description: '讀取 ERP 投遞狀態' },
      { key: 'erp:write', description: '重送訂單到 ERP' },
    ],
    requiredSecrets: [DEMO_ERP_API_KEY],
    configuration: demoErpConfig,
    subscribedEvents: ['commerce.order.paid.v1'],
    registeredCommands: [resendOrderCommand.name],
    registeredQueries: [listDeliveriesQuery.name],
    registeredProviders: [{ kind: 'erp', id: 'demo-erp', isDefault: true }],
  },
  setup(ctx) {
    return {
      providers: [createDemoErpProvider(ctx)],
      events: [{ event: 'commerce.order.paid.v1', handler: createOrderPaidHandler(), maxAttempts: 8 }],
      jobs: [{ type: PUSH_ORDER_JOB, handler: createPushOrderJob() }],
      commands: [{ descriptor: resendOrderCommand, handler: createResendHandler() }],
      queries: [{ descriptor: listDeliveriesQuery, handler: createListDeliveriesHandler() }],
    };
  },
  async healthCheck(ctx) {
    const deliveries = await ctx.store.list<DeliveryRecord>('delivery:', 200);
    const failed = deliveries.filter((d) => d.value.status === 'failed').length;
    const pending = deliveries.filter((d) => d.value.status === 'pending').length;
    return {
      ok: failed === 0,
      message: `endpoint=${ctx.config.endpoint} sent=${deliveries.length - failed - pending} pending=${pending} failed=${failed}`,
    };
  },
});

export * from './config';
export * from './state';
export * from './transform';
export default demoErpExtension;
