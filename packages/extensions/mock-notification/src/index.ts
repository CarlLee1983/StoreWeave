import { defineExtension } from '@storeweave/extension-sdk';
import { mockNotificationConfig, type MockNotificationConfig } from './config';
import { createMockNotificationProvider } from './provider';

export const mockNotificationExtension = defineExtension<MockNotificationConfig>({
  manifest: {
    id: 'mock-notification',
    name: 'Mock Notification',
    version: '1.0.0',
    platformVersion: '^1.0.0',
    description: '開發與測試用的模擬通知；示範 Notification Provider Contract。',
    permissions: [],
    configuration: mockNotificationConfig,
    subscribedEvents: [],
    registeredCommands: [],
    registeredQueries: [],
    registeredProviders: [{ kind: 'notification', id: 'mock-notification', isDefault: true }],
  },
  setup(ctx) {
    return { providers: [createMockNotificationProvider(ctx)] };
  },
  async healthCheck(ctx) {
    return { ok: true, message: `deliver=${ctx.config.deliver}` };
  },
});

export * from './config';
export * from './provider';
export default mockNotificationExtension;
