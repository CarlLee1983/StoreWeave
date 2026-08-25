import { z } from 'zod';
import { defineEvent } from '@storeweave/contracts';
const payload=z.object({rmaId:z.string().uuid(),orderId:z.string().uuid(),occurredAt:z.coerce.date()});
export const rmaRequestedV1=defineEvent({name:'commerce.rma.requested.v1',summary:'退貨案件已建立',payload});
export const rmaStatusChangedV1=defineEvent({name:'commerce.rma.changed.v1',summary:'退貨案件狀態已變更',payload:payload.extend({status:z.string()})});
export const rmaEvents=[rmaRequestedV1,rmaStatusChangedV1];
