import packageJson from '../package.json';
import { defineModule, type BoundModuleCapability, type PlatformPorts } from '@storeweave/kernel';
import type { MediaReferencesPort } from '@storeweave/media';
import type { NotificationsPort } from '@storeweave/notifications';
import { createArticleCommand,createArticleHandler,createDeleteArticleHandler,createSetArticleMediaHandler,createSubmitContactMessageHandler,deleteArticleCommand,markContactMessageHandledCommand,markContactMessageHandledHandler,publishArticleCommand,publishArticleHandler,setArticleMediaCommand,submitContactMessageCommand,unpublishArticleCommand,unpublishArticleHandler,updateArticleCommand,updateArticleHandler,type ContactCustomerIdResolver,type ContactNotificationRecipientResolver } from './commands';
import { contentEvents } from './events';
import { contentMigrations } from './migrations';
import { getArticleHandler,getArticleQuery,getPublishedKindsHandler,getPublishedKindsQuery,getContactMessageHandler,getContactMessageQuery,getPublishedArticleHandler,getPublishedArticleQuery,getPublishedMediaHandler,getPublishedMediaQuery,listArticlesHandler,listArticlesQuery,listContactMessagesHandler,listContactMessagesQuery,listPublishedArticlesHandler,listPublishedArticlesQuery,listPublishedSiteContentHandler,listPublishedSiteContentQuery } from './queries';
import { contentPages } from './pages';
export interface ContentModuleOptions {
  /** Commerce may bind its Customer projection; Base deliberately has none. */
  readonly customerIdForActor?: BoundModuleCapability<ContactCustomerIdResolver>;
  readonly contactNotificationRecipient?: BoundModuleCapability<ContactNotificationRecipientResolver>;
}

export function createContentModule(options:ContentModuleOptions={}){
  let mediaReferences:MediaReferencesPort|undefined;
  let notifications:NotificationsPort|undefined;
  const bindings = [options.customerIdForActor, options.contactNotificationRecipient].filter(Boolean) as BoundModuleCapability<unknown>[];
  return defineModule({name:'content',
  version: packageJson.version,
  baseVersionRange: '^1.0.0',
  dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }] },
  capabilities: bindings.length ? {
    optional: bindings.map(binding=>({from:binding.from,versionRange:'^0.1.0',capability:binding.capability})),
    bound: bindings,
  } : undefined,
  data: { owns: ['content_articles', 'content_contact_messages', 'content_legacy_media_mappings'] },migrations:contentMigrations,events:contentEvents,permissions:[
 {key:'content:read',description:'讀取品牌內容，含草稿',owner:'content'},
 {key:'content:write',description:'建立與發布品牌內容',owner:'content'},
 {key:'content:public-read',description:'讀取已發布的品牌內容',owner:'content'},
 {key:'contact:submit',description:'送出聯絡訊息',owner:'content'},
 {key:'contact:read',description:'讀取聯絡訊息',owner:'content'},
 {key:'contact:write',description:'處理聯絡訊息',owner:'content'},
],commands:[
 {descriptor:createArticleCommand,handler:createArticleHandler},
 {descriptor:updateArticleCommand,handler:updateArticleHandler},
 {descriptor:publishArticleCommand,handler:publishArticleHandler},
 {descriptor:unpublishArticleCommand,handler:unpublishArticleHandler},
 {descriptor:deleteArticleCommand,handler:createDeleteArticleHandler(()=>mediaReferences)},
 {descriptor:setArticleMediaCommand,handler:createSetArticleMediaHandler(()=>mediaReferences)},
 {descriptor:submitContactMessageCommand,handler:createSubmitContactMessageHandler(options.customerIdForActor?.value,options.contactNotificationRecipient?.value,()=>notifications)},
 {descriptor:markContactMessageHandledCommand,handler:markContactMessageHandledHandler},
],queries:[
 {descriptor:listArticlesQuery,handler:listArticlesHandler},
 {descriptor:getArticleQuery,handler:getArticleHandler},
 {descriptor:listPublishedArticlesQuery,handler:listPublishedArticlesHandler},
 {descriptor:listPublishedSiteContentQuery,handler:listPublishedSiteContentHandler},
 {descriptor:getPublishedArticleQuery,handler:getPublishedArticleHandler},
 {descriptor:getPublishedMediaQuery,handler:getPublishedMediaHandler},
 {descriptor:getPublishedKindsQuery,handler:getPublishedKindsHandler},
 {descriptor:listContactMessagesQuery,handler:listContactMessagesHandler},
 {descriptor:getContactMessageQuery,handler:getContactMessageHandler},
],pages:contentPages,
 bindPorts:(ports:PlatformPorts)=>{mediaReferences=ports.media;notifications=ports.notifications;},
});}
