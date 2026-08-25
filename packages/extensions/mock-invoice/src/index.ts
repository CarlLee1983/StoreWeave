import { defineExtension } from '@storeweave/extension-sdk';
import { mockInvoiceConfig, type MockInvoiceConfig } from './config';
import { createMockInvoiceProvider, MOCK_INVOICE_PROVIDER_ID } from './provider';
export const mockInvoiceExtension = defineExtension<MockInvoiceConfig>({ manifest: { id: 'mock-invoice', name: 'Mock Invoice', version: '1.0.0', platformVersion: '^1.0.0', description: 'Development and test B2C invoice provider.', permissions: [], configuration: mockInvoiceConfig, subscribedEvents: [], registeredCommands: [], registeredQueries: [], registeredProviders: [{ kind: 'invoice', id: MOCK_INVOICE_PROVIDER_ID, isDefault: true }] }, setup(ctx) { return { providers: [createMockInvoiceProvider(ctx)] }; } });
export * from './config'; export * from './provider'; export default mockInvoiceExtension;
