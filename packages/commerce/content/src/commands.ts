import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { PlatformError,defineCommand,type CommandContext } from '@storeweave/contracts';
import { customerService } from '@storeweave/customer';
import { articleDto,articleIdInput,contactMessageDto,createArticleInput,markContactMessageHandledInput,submitContactMessageInput,updateArticleInput,type ArticleDto,type ContactMessageDto } from './dto';
import { articlePublishedV1,contactMessageSubmittedV1 } from './events';
import { ContentRepository,toArticleDto,toContactMessageDto } from './repository';
const repository=new ContentRepository();
async function locked(ctx:CommandContext,id:string){const row=await repository.lockById(ctx.tx,id);if(!row)throw PlatformError.notFound('Article',id);return row;}
/** The unique index is the real guard; this turns its violation into a readable message. */
async function requireFreeSlug(ctx:CommandContext,kind:string,slug:string,exceptId?:string){if(await repository.slugTaken(ctx.tx,kind,slug,exceptId))throw PlatformError.conflict(`Slug ${slug} is already used by another ${kind} article`);}

export const createArticleCommand=defineCommand({name:'commerce.content.createArticle',summary:'建立品牌內容',input:createArticleInput,output:articleDto,permission:'content:write',idempotency:'required',audit:{action:'content.article.created',resourceType:'content_article',resourceId:(_i,o:ArticleDto)=>o.id,redact:i=>({kind:i.kind,slug:i.slug})}});
export const createArticleHandler=async(input:z.infer<typeof createArticleInput>,ctx:CommandContext):Promise<ArticleDto>=>{await requireFreeSlug(ctx,input.kind,input.slug);const row=await repository.insert(ctx.tx,{id:randomUUID(),kind:input.kind,slug:input.slug,title:input.title,summary:input.summary,section:input.section,body:input.body,imageKey:input.imageKey,position:input.position,status:'draft',publishedAt:null,createdAt:ctx.now,updatedAt:ctx.now});return toArticleDto(row);};

export const updateArticleCommand=defineCommand({name:'commerce.content.updateArticle',summary:'編輯品牌內容',input:updateArticleInput,output:articleDto,permission:'content:write',idempotency:'required',audit:{action:'content.article.updated',resourceType:'content_article',resourceId:i=>i.id}});
export const updateArticleHandler=async(input:z.infer<typeof updateArticleInput>,ctx:CommandContext):Promise<ArticleDto>=>{const {id,...patch}=input;const row=await locked(ctx,id);if(patch.slug!==undefined)await requireFreeSlug(ctx,row.kind,patch.slug,id);const updated=await repository.update(ctx.tx,id,patch,ctx.now);if(!updated)throw PlatformError.notFound('Article',id);return toArticleDto(updated);};

export const publishArticleCommand=defineCommand({name:'commerce.content.publishArticle',summary:'發布品牌內容',input:articleIdInput,output:articleDto,permission:'content:write',idempotency:'required',audit:{action:'content.article.published',resourceType:'content_article',resourceId:i=>i.id}});
export const publishArticleHandler=async(input:z.infer<typeof articleIdInput>,ctx:CommandContext):Promise<ArticleDto>=>{const row=await locked(ctx,input.id);if(row.status==='published')return toArticleDto(row);const updated=await repository.update(ctx.tx,row.id,{status:'published',publishedAt:ctx.now},ctx.now);if(!updated)throw PlatformError.notFound('Article',input.id);await ctx.publish({name:articlePublishedV1.name,payload:{articleId:updated.id,kind:updated.kind,slug:updated.slug,occurredAt:ctx.now}});return toArticleDto(updated);};

export const unpublishArticleCommand=defineCommand({name:'commerce.content.unpublishArticle',summary:'把品牌內容收回草稿',input:articleIdInput,output:articleDto,permission:'content:write',idempotency:'required',audit:{action:'content.article.unpublished',resourceType:'content_article',resourceId:i=>i.id}});
export const unpublishArticleHandler=async(input:z.infer<typeof articleIdInput>,ctx:CommandContext):Promise<ArticleDto>=>{const row=await locked(ctx,input.id);if(row.status==='draft')return toArticleDto(row);const updated=await repository.update(ctx.tx,row.id,{status:'draft',publishedAt:null},ctx.now);if(!updated)throw PlatformError.notFound('Article',input.id);return toArticleDto(updated);};

export const deleteArticleCommand=defineCommand({name:'commerce.content.deleteArticle',summary:'刪除品牌內容',input:articleIdInput,output:articleDto,permission:'content:write',idempotency:'required',audit:{action:'content.article.deleted',resourceType:'content_article',resourceId:i=>i.id}});
export const deleteArticleHandler=async(input:z.infer<typeof articleIdInput>,ctx:CommandContext):Promise<ArticleDto>=>{await locked(ctx,input.id);const removed=await repository.remove(ctx.tx,input.id);if(!removed)throw PlatformError.notFound('Article',input.id);return toArticleDto(removed);};

export const submitContactMessageCommand=defineCommand({name:'commerce.content.submitContactMessage',summary:'顧客送出聯絡訊息',input:submitContactMessageInput,output:contactMessageDto,permission:'contact:submit',idempotency:'required',audit:{action:'content.contact.submitted',resourceType:'content_contact_message',resourceId:(_i,o:ContactMessageDto)=>o.id,redact:i=>({subject:i.subject})}});
export const submitContactMessageHandler=async(input:z.infer<typeof submitContactMessageInput>,ctx:CommandContext):Promise<ContactMessageDto>=>{
 // Anonymous visitors may write; a signed-in sender is linked so staff can see who asked.
 const customerId=ctx.actor.type==='customer'?await customerService.customerIdOf(ctx.tx,ctx.actor):null;
 const row=await repository.insertContactMessage(ctx.tx,{id:randomUUID(),customerId,name:input.name,email:input.email,subject:input.subject,message:input.message,status:'new',createdAt:ctx.now});
 // No email is sent: notification is order-bound today.  The event is the seam.
 await ctx.publish({name:contactMessageSubmittedV1.name,payload:{messageId:row.id,subject:row.subject,occurredAt:ctx.now}});
 return toContactMessageDto(row);};

export const markContactMessageHandledCommand=defineCommand({name:'commerce.content.markContactMessageHandled',summary:'把聯絡訊息標記為已處理',input:markContactMessageHandledInput,output:contactMessageDto,permission:'contact:write',idempotency:'required',audit:{action:'content.contact.handled',resourceType:'content_contact_message',resourceId:i=>i.id}});
export const markContactMessageHandledHandler=async(input:z.infer<typeof markContactMessageHandledInput>,ctx:CommandContext):Promise<ContactMessageDto>=>{const row=await repository.lockContactMessage(ctx.tx,input.id);if(!row)throw PlatformError.notFound('ContactMessage',input.id);if(row.status==='handled')throw PlatformError.conflict(`Contact message ${row.id} is already handled`);const updated=await repository.updateContactMessage(ctx.tx,row.id,{status:'handled',handledByActorId:ctx.actor.id,handledAt:ctx.now});if(!updated)throw PlatformError.notFound('ContactMessage',input.id);return toContactMessageDto(updated);};
