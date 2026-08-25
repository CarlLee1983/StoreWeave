import { z } from 'zod';

export const ECPAY_LOGISTICS_MERCHANT_ID_SECRET = 'ECPAY_LOGISTICS_MERCHANT_ID';
export const ECPAY_LOGISTICS_HASH_KEY_SECRET = 'ECPAY_LOGISTICS_HASH_KEY';
export const ECPAY_LOGISTICS_HASH_IV_SECRET = 'ECPAY_LOGISTICS_HASH_IV';

export const ECPAY_LOGISTICS_PROVIDER_ID = 'ecpay-logistics';
export const CREATE_ECPAY_LOGISTICS_SHIPMENT_JOB = 'ext.ecpay-logistics.create-shipment';
export const QUERY_ECPAY_LOGISTICS_SHIPMENT_STATUS_JOB = 'ext.ecpay-logistics.query-shipment-status';
export const RECONCILE_ECPAY_LOGISTICS_SHIPMENT_STATUSES_JOB = 'ext.ecpay-logistics.reconcile-shipment-statuses';

/**
 * The official sources describe more than one logistics contract and the
 * merchant's enabled service subtype selects the actual request shape. Until
 * that contract is confirmed in UAT, this extension deliberately has no live
 * endpoint configuration to accidentally call.
 */
export const ecpayLogisticsConfig = z.object({
  environment: z.enum(['stage', 'production']).default('stage'),
  /** `fake` is a deterministic repository test carrier; `external_gate` never performs network I/O. */
  mode: z.enum(['fake', 'external_gate']).default('external_gate'),
  /** Store-owned shipping `type` values this first home-delivery slice may process. */
  homeDeliveryServiceTypes: z.array(z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/)).min(1).default(['home_delivery']),
  /** Fake-only pickup methods and stores for the storefront selection contract. */
  pickupServiceTypes: z.array(z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/)).default([]),
  pickupStores: z.array(z.object({
    providerStoreId: z.string().min(1).max(120), storeName: z.string().min(1).max(200), storeAddress: z.string().min(1).max(400),
  }).strict()).default([]),
  maxAttempts: z.number().int().min(1).max(20).default(5),
  /** Background reconciliation uses one bounded batch per scheduled occurrence. */
  statusQueryIntervalMinutes: z.number().int().min(5).max(24 * 60).default(30),
  statusQueryBatchSize: z.number().int().min(1).max(500).default(100),
  /** Test-only: fake carrier records the consignment, then drops this many responses. */
  fakeTimeoutsAfterCreate: z.number().int().min(0).max(10).default(0),
  /** Test-only deterministic answer for proactive status reconciliation. */
  fakeQueryStage: z.enum(['created', 'shipped', 'arrived', 'completed']).default('shipped'),
}).strict().superRefine((config, context) => {
  if (config.mode !== 'fake' && config.fakeTimeoutsAfterCreate > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fakeTimeoutsAfterCreate'],
      message: 'is only valid in fake mode',
    });
  }
  if (config.mode !== 'fake' && config.fakeQueryStage !== 'shipped') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fakeQueryStage'],
      message: 'is only configurable in fake mode',
    });
  }
  if (config.environment === 'production' && config.mode === 'fake') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mode'],
      message: 'fake mode cannot be used in production',
    });
  }
  if (config.mode !== 'fake' && (config.pickupServiceTypes.length || config.pickupStores.length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['pickupStores'], message: 'pickup selection is only available in fake mode until UAT confirms a live contract' });
  }
  if (config.pickupServiceTypes.length > 0 && config.pickupStores.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['pickupStores'], message: 'at least one fake pickup store is required when pickup service types are enabled' });
  }
});

export type EcpayLogisticsConfig = z.infer<typeof ecpayLogisticsConfig>;
