import { defineExtension } from '@storeweave/extension-sdk';
import {
  CREATE_ECPAY_LOGISTICS_SHIPMENT_JOB, ECPAY_LOGISTICS_HASH_IV_SECRET,
  ECPAY_LOGISTICS_HASH_KEY_SECRET, ECPAY_LOGISTICS_MERCHANT_ID_SECRET,
  ECPAY_LOGISTICS_PROVIDER_ID, QUERY_ECPAY_LOGISTICS_SHIPMENT_STATUS_JOB,
  RECONCILE_ECPAY_LOGISTICS_SHIPMENT_STATUSES_JOB, ecpayLogisticsConfig, type EcpayLogisticsConfig,
} from './config';
import {
  createEcpayLogisticsShipmentJob, createEcpayLogisticsStatusQueryJob,
  createEcpayLogisticsStatusReconciliationJob, createGetShipmentOperationHandler,
  createListShipmentOperationsHandler, createRetryShipmentHandler,
  createShipmentCreatedHandler, getShipmentOperationQuery, listShipmentOperationsQuery,
  retryShipmentCommand, recurringStatusPayload, shipmentIdInput,
} from './handlers';
import { createEcpayLogisticsProvider } from './provider';

export const ecpayLogisticsExtension = defineExtension<EcpayLogisticsConfig>({
  manifest: {
    id: 'ecpay-logistics',
    name: 'ECPay Logistics',
    version: '1.0.0',
    platformVersion: '^1.0.0',
    description: 'ECPay home-delivery carrier adapter with durable shipment and proactive-status jobs; live transport remains UAT-gated.',
    permissions: ['shipping:provider-read', 'shipping:provider-write'],
    declaredPermissions: [
      { key: 'ecpay-logistics:read', description: '讀取綠界物流建單與主動查詢營運狀態' },
      { key: 'ecpay-logistics:write', description: '重試綠界物流建單' },
    ],
    configuration: ecpayLogisticsConfig,
    subscribedEvents: ['commerce.shipment.created.v1'],
    registeredCommands: [retryShipmentCommand.name],
    registeredQueries: [getShipmentOperationQuery.name, listShipmentOperationsQuery.name],
    registeredJobs: [CREATE_ECPAY_LOGISTICS_SHIPMENT_JOB, QUERY_ECPAY_LOGISTICS_SHIPMENT_STATUS_JOB, RECONCILE_ECPAY_LOGISTICS_SHIPMENT_STATUSES_JOB],
    registeredProviders: [{ kind: 'shipping', id: ECPAY_LOGISTICS_PROVIDER_ID, isDefault: true }],
    requiredSecrets: [
      ECPAY_LOGISTICS_MERCHANT_ID_SECRET,
      ECPAY_LOGISTICS_HASH_KEY_SECRET,
      ECPAY_LOGISTICS_HASH_IV_SECRET,
    ],
  },
  setup(ctx) {
    return {
      providers: [createEcpayLogisticsProvider(ctx)],
      events: [{ event: 'commerce.shipment.created.v1', handler: createShipmentCreatedHandler(), maxAttempts: 8 }],
      jobs: [
        { type: CREATE_ECPAY_LOGISTICS_SHIPMENT_JOB, handler: createEcpayLogisticsShipmentJob(), jobContractV1: { currentVersion: 1, versions: { 1: shipmentIdInput } } },
        { type: QUERY_ECPAY_LOGISTICS_SHIPMENT_STATUS_JOB, handler: createEcpayLogisticsStatusQueryJob(), jobContractV1: { currentVersion: 1, versions: { 1: shipmentIdInput } } },
        {
          type: RECONCILE_ECPAY_LOGISTICS_SHIPMENT_STATUSES_JOB,
          handler: createEcpayLogisticsStatusReconciliationJob(),
          jobContractV1: { currentVersion: 1, versions: { 1: recurringStatusPayload } },
          schedule: { everyMs: ctx.config.statusQueryIntervalMinutes * 60_000 },
        },
      ],
      commands: [{ descriptor: retryShipmentCommand, handler: createRetryShipmentHandler() }],
      queries: [
        { descriptor: getShipmentOperationQuery, handler: createGetShipmentOperationHandler() },
        { descriptor: listShipmentOperationsQuery, handler: createListShipmentOperationsHandler() },
      ],
    };
  },
  async healthCheck(ctx) {
    const provider = createEcpayLogisticsProvider(ctx);
    return provider.healthCheck!();
  },
});

export * from './config';
export * from './handlers';
export * from './provider';
export * from './state';
export default ecpayLogisticsExtension;
