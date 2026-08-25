import { z } from 'zod';
import { defineEvent } from '@storeweave/contracts';
const payload = z.object({ refundId:z.string().uuid(),orderId:z.string().uuid(),source:z.enum(['direct','rma']),sourceRef:z.string().uuid().nullable(),amountCents:z.number().int().positive(),currency:z.string().length(3),paymentProvider:z.string(),paymentProviderRef:z.string(),providerRequestRef:z.string(),attemptNo:z.number().int().positive(),occurredAt:z.coerce.date() });
export const refundRequestedV1=defineEvent({name:'commerce.refund.requested.v1',summary:'退款已請求',payload});
export const refundSucceededV1=defineEvent({name:'commerce.refund.succeeded.v1',summary:'退款已成功',payload});
export const refundFailedV1=defineEvent({name:'commerce.refund.failed.v1',summary:'退款被 provider 拒絕',payload:payload.extend({failureMessage:z.string()})});
export const refundEvents=[refundRequestedV1,refundSucceededV1,refundFailedV1];
