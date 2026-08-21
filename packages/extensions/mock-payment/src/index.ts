import { defineExtension } from '@storeweave/extension-sdk';
import { mockPaymentConfig, type MockPaymentConfig } from './config';
import { createMockPaymentProvider } from './provider';

export const mockPaymentExtension = defineExtension<MockPaymentConfig>({
  manifest: {
    id: 'mock-payment',
    name: 'Mock Payment',
    version: '1.0.0',
    platformVersion: '^1.0.0',
    description: '開發與測試用的模擬金流；示範 Payment Provider Contract。',
    permissions: [],
    configuration: mockPaymentConfig,
    subscribedEvents: [],
    registeredCommands: [],
    registeredQueries: [],
    registeredProviders: [{ kind: 'payment', id: 'mock-payment', isDefault: true }],
  },
  setup(ctx) {
    return { providers: [createMockPaymentProvider(ctx)] };
  },
  async healthCheck(ctx) {
    return { ok: true, message: `autoApprove=${ctx.config.autoApprove}` };
  },
});

export * from './config';
export * from './provider';
export default mockPaymentExtension;
