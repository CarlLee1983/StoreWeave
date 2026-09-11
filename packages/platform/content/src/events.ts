import { z } from 'zod';
import { defineEvent } from '@storeweave/contracts';
export const articlePublishedV1=defineEvent({name:'commerce.content.article.published.v1',summary:'品牌內容已發布',payload:z.object({articleId:z.string().uuid(),kind:z.string(),slug:z.string(),occurredAt:z.coerce.date()})});
export const contactMessageSubmittedV1=defineEvent({name:'commerce.content.contact.submitted.v1',summary:'顧客送出聯絡訊息',payload:z.object({messageId:z.string().uuid(),subject:z.string(),occurredAt:z.coerce.date()})});
export const contentEvents=[articlePublishedV1,contactMessageSubmittedV1];
