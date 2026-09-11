import { z } from 'zod';
import { defineEvent } from '@storeweave/contracts';

/** 事件名稱是公開契約：形狀改變時發 `.v2`，舊版保留到沒有訂閱者為止。 */
export const fileRequestSubmittedV1 = defineEvent({
  name: 'filerequests.request.submitted.v1',
  payload: z.object({ requestId: z.string().uuid(), ownerActorId: z.string() }),
});

export const fileRequestDecidedV1 = defineEvent({
  name: 'filerequests.request.decided.v1',
  payload: z.object({ requestId: z.string().uuid(), decision: z.enum(['approved', 'rejected']) }),
});

export const fileRequestEvents = [fileRequestSubmittedV1, fileRequestDecidedV1];
