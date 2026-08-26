import { z } from 'zod';
export const articleKind=z.enum(['story','journal','news','faq']);
export const articleStatus=z.enum(['draft','published']);
export type ArticleKind=z.infer<typeof articleKind>;
/** Lowercase, hyphen-separated: it is the public URL segment, not a display string. */
const slug=z.string().trim().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/,'slug must be lowercase words joined by hyphens');
/** A block is one paragraph, optionally titled — a story chapter is a titled block. */
export const articleBlock=z.object({heading:z.string().trim().min(1).max(200).nullable().default(null),text:z.string().trim().min(1).max(4000)}).strict();
const body=z.array(articleBlock).max(60);
const imageKey=z.string().trim().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/,'image key must be lowercase words joined by hyphens').nullable();
export const articleDto=z.object({id:z.string().uuid(),kind:articleKind,slug:z.string(),title:z.string(),summary:z.string(),section:z.string(),body:z.array(z.object({heading:z.string().nullable(),text:z.string()})),imageKey:z.string().nullable(),position:z.number().int(),status:articleStatus,publishedAt:z.coerce.date().nullable(),createdAt:z.coerce.date(),updatedAt:z.coerce.date()});
export type ArticleDto=z.infer<typeof articleDto>;
export const createArticleInput=z.object({kind:articleKind,slug,title:z.string().trim().min(1).max(200),summary:z.string().trim().max(500).default(''),section:z.string().trim().max(60).default(''),body:body.default([]),imageKey:imageKey.default(null),position:z.number().int().min(0).max(9999).default(0)}).strict();
/** Every field is optional, but an empty patch is refused: a no-op write should not audit. */
export const updateArticleInput=z.object({id:z.string().uuid(),slug:slug.optional(),title:z.string().trim().min(1).max(200).optional(),summary:z.string().trim().max(500).optional(),section:z.string().trim().max(60).optional(),body:body.optional(),imageKey:imageKey.optional(),position:z.number().int().min(0).max(9999).optional()}).strict().refine(value=>Object.keys(value).length>1,'at least one field must change');
export const articleIdInput=z.object({id:z.string().uuid()}).strict();
export const listArticlesInput=z.object({kind:articleKind.optional(),status:articleStatus.optional(),limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).default(0)}).strict();
export const listArticlesOutput=z.object({items:z.array(articleDto),total:z.number().int().nonnegative()});
export const listPublishedArticlesInput=z.object({kind:articleKind,limit:z.coerce.number().int().min(1).max(100).default(50)}).strict();
export const listPublishedArticlesOutput=z.object({items:z.array(articleDto)});
export const getPublishedArticleInput=z.object({kind:articleKind,slug}).strict();
export const emptyInput=z.object({}).strict();
export const publishedKindsOutput=z.object({kinds:z.array(articleKind)});

export const contactStatus=z.enum(['new','handled']);
export const contactMessageDto=z.object({id:z.string().uuid(),customerId:z.string().uuid().nullable(),name:z.string(),email:z.string(),subject:z.string(),message:z.string(),status:contactStatus,handledByActorId:z.string().nullable(),handledAt:z.coerce.date().nullable(),createdAt:z.coerce.date()});
export type ContactMessageDto=z.infer<typeof contactMessageDto>;
export const submitContactMessageInput=z.object({name:z.string().trim().min(1).max(80),email:z.string().trim().email().max(320),subject:z.string().trim().min(1).max(200),message:z.string().trim().min(1).max(4000)}).strict();
export const markContactMessageHandledInput=z.object({id:z.string().uuid()}).strict();
export const listContactMessagesInput=z.object({status:contactStatus.optional(),limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).default(0)}).strict();
export const listContactMessagesOutput=z.object({items:z.array(contactMessageDto),total:z.number().int().nonnegative()});
