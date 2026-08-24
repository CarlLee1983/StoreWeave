import { defineExtension } from '@storeweave/extension-sdk';
import { ecpayPaymentConfig, type EcpayPaymentConfig, ECPAY_HASH_IV_SECRET, ECPAY_HASH_KEY_SECRET, ECPAY_MERCHANT_ID_SECRET } from './config';
import { createEcpayPaymentProvider, ECPAY_PAYMENT_PROVIDER_ID } from './provider';

export const ecpayPaymentExtension = defineExtension<EcpayPaymentConfig>({
  manifest: {
    id: 'ecpay',
    name: 'ECPay Payment',
    version: '1.0.0',
    platformVersion: '^1.0.0',
    description: 'ECPay All-in-One Payment checkout adapter for Taiwan.',
    permissions: [],
    configuration: ecpayPaymentConfig,
    subscribedEvents: [],
    registeredCommands: [],
    registeredQueries: [],
    registeredProviders: [{ kind: 'payment', id: ECPAY_PAYMENT_PROVIDER_ID, isDefault: true }],
    requiredSecrets: [ECPAY_MERCHANT_ID_SECRET, ECPAY_HASH_KEY_SECRET, ECPAY_HASH_IV_SECRET],
  },
  setup(ctx) {
    return { providers: [createEcpayPaymentProvider(ctx)] };
  },
});

export * from './check-mac-value';
export * from './config';
export * from './provider';
export default ecpayPaymentExtension;
