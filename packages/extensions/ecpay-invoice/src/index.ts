import { defineExtension } from '@storeweave/extension-sdk';
import { ecpayInvoiceConfig, ECPAY_INVOICE_HASH_IV_SECRET, ECPAY_INVOICE_HASH_KEY_SECRET, ECPAY_INVOICE_MERCHANT_ID_SECRET, type EcpayInvoiceConfig } from './config';
import { createEcpayInvoiceProvider, ECPAY_INVOICE_PROVIDER_ID } from './provider';

export const ecpayInvoiceExtension = defineExtension<EcpayInvoiceConfig>({
  manifest: { id: 'ecpay-invoice', name: 'ECPay B2C Invoice', version: '1.0.0', platformVersion: '^1.0.0', description: 'ECPay B2C electronic-invoice adapter for Taiwan.', permissions: [], configuration: ecpayInvoiceConfig, subscribedEvents: [], registeredCommands: [], registeredQueries: [], registeredProviders: [{ kind: 'invoice', id: ECPAY_INVOICE_PROVIDER_ID, isDefault: true }], requiredSecrets: [ECPAY_INVOICE_MERCHANT_ID_SECRET, ECPAY_INVOICE_HASH_KEY_SECRET, ECPAY_INVOICE_HASH_IV_SECRET] },
  setup(ctx) { return { providers: [createEcpayInvoiceProvider(ctx)] }; },
});
export * from './config';
export * from './provider';
export default ecpayInvoiceExtension;
