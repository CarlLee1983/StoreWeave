import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { PlatformError,defineCommand,type Actor,type CommandContext,type Tx } from '@storeweave/contracts';
import type { MediaReferencesPort } from '@storeweave/media';
import type { NotificationsPort } from '@storeweave/notifications';
import { articleDto,articleIdInput,contactMessageDto,createArticleInput,markContactMessageHandledInput,setArticleMediaInput,submitContactMessageInput,updateArticleInput,type ArticleDto,type ContactMessageDto } from './dto';
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
export const createDeleteArticleHandler=(mediaReferences:()=>MediaReferencesPort|undefined)=>
  async(input:z.infer<typeof articleIdInput>,ctx:CommandContext):Promise<ArticleDto>=>{const row=await locked(ctx,input.id);const references=mediaReferences();if(!references)throw PlatformError.validation('Content media is not available in this release');await references.replace(ctx.tx,{ownerType:'content.article',ownerId:row.id,mediaIds:[]});const removed=await repository.remove(ctx.tx,input.id);if(!removed)throw PlatformError.notFound('Article',input.id);return toArticleDto(removed);};

export const setArticleMediaCommand=defineCommand({name:'commerce.content.setArticleMedia',summary:'指定品牌內容的媒體',input:setArticleMediaInput,output:articleDto,permission:'content:write',idempotency:'required',audit:{action:'content.article.media-set',resourceType:'content_article',resourceId:i=>i.id}});
export const createSetArticleMediaHandler=(mediaReferences:()=>MediaReferencesPort|undefined)=>
  async(input:z.infer<typeof setArticleMediaInput>,ctx:CommandContext):Promise<ArticleDto>=>{
    const row=await locked(ctx,input.id);
    const references=mediaReferences();
    if(!references)throw PlatformError.validation('Content media is not available in this release');
    // Media validates that every retained asset is ready before this row can name it.
    await references.replace(ctx.tx,{ownerType:'content.article',ownerId:row.id,mediaIds:input.mediaAssetId?[input.mediaAssetId]:[]});
    const updated=await repository.update(ctx.tx,row.id,{mediaAssetId:input.mediaAssetId},ctx.now);
    if(!updated)throw PlatformError.notFound('Article',input.id);
    return toArticleDto(updated);
  };

export const submitContactMessageCommand=defineCommand({name:'commerce.content.submitContactMessage',summary:'顧客送出聯絡訊息',input:submitContactMessageInput,output:contactMessageDto,permission:'contact:submit',idempotency:'required',audit:{action:'content.contact.submitted',resourceType:'content_contact_message',resourceId:(_i,o:ContactMessageDto)=>o.id,redact:i=>({subject:i.subject})}});
/** A Commerce release may link a sender to Customer; a base website has no Customer aggregate. */
export type ContactCustomerIdResolver = (tx: Tx, actor: Actor) => Promise<string | null>;
export type ContactNotificationRecipientResolver = (tx: Tx) => Promise<string | null>;

export const createSubmitContactMessageHandler = (customerIdForActor?: ContactCustomerIdResolver, contactNotificationRecipient?: ContactNotificationRecipientResolver, notifications?: () => NotificationsPort | undefined) =>
  async(input:z.infer<typeof submitContactMessageInput>,ctx:CommandContext):Promise<ContactMessageDto>=>{
 // Anonymous visitors may write; a Commerce release can link a signed-in sender.
 const customerId=ctx.actor.type==='customer'&&customerIdForActor
   ?await customerIdForActor(ctx.tx,ctx.actor):null;
 const row=await repository.insertContactMessage(ctx.tx,{id:randomUUID(),customerId,name:input.name,email:input.email,subject:input.subject,message:input.message,status:'new',createdAt:ctx.now});
 const recipientEmail=contactNotificationRecipient ? await contactNotificationRecipient(ctx.tx) : null;
 const notificationPort=notifications?.();
 if(recipientEmail&&notificationPort)await notificationPort.send(ctx.tx,{reference:`content.contact:${row.id}`,channels:['email'],recipient:{email:recipientEmail},template:{id:'site.contact.submitted',version:1,email:{subject:'新的網站聯絡訊息',text:'網站收到一則新的聯絡訊息，請至後台收件匣查看。',html:'<p>網站收到一則新的聯絡訊息，請至後台收件匣查看。</p>'}}},ctx.enqueue,ctx.now);
 await ctx.publish({name:contactMessageSubmittedV1.name,payload:{messageId:row.id,subject:row.subject,occurredAt:ctx.now}});
 return toContactMessageDto(row);};

export const markContactMessageHandledCommand=defineCommand({name:'commerce.content.markContactMessageHandled',summary:'把聯絡訊息標記為已處理',input:markContactMessageHandledInput,output:contactMessageDto,permission:'contact:write',idempotency:'required',audit:{action:'content.contact.handled',resourceType:'content_contact_message',resourceId:i=>i.id}});
export const markContactMessageHandledHandler=async(input:z.infer<typeof markContactMessageHandledInput>,ctx:CommandContext):Promise<ContactMessageDto>=>{const row=await repository.lockContactMessage(ctx.tx,input.id);if(!row)throw PlatformError.notFound('ContactMessage',input.id);if(row.status==='handled')throw PlatformError.conflict(`Contact message ${row.id} is already handled`);const updated=await repository.updateContactMessage(ctx.tx,row.id,{status:'handled',handledByActorId:ctx.actor.id,handledAt:ctx.now});if(!updated)throw PlatformError.notFound('ContactMessage',input.id);return toContactMessageDto(updated);};
