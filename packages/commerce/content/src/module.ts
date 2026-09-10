import packageJson from '../package.json';
import { defineModule } from '@storeweave/kernel';
import { createArticleCommand,createArticleHandler,deleteArticleCommand,deleteArticleHandler,markContactMessageHandledCommand,markContactMessageHandledHandler,publishArticleCommand,publishArticleHandler,submitContactMessageCommand,submitContactMessageHandler,unpublishArticleCommand,unpublishArticleHandler,updateArticleCommand,updateArticleHandler } from './commands';
import { contentEvents } from './events';
import { contentMigrations } from './migrations';
import { getArticleHandler,getArticleQuery,getPublishedKindsHandler,getPublishedKindsQuery,getContactMessageHandler,getContactMessageQuery,getPublishedArticleHandler,getPublishedArticleQuery,listArticlesHandler,listArticlesQuery,listContactMessagesHandler,listContactMessagesQuery,listPublishedArticlesHandler,listPublishedArticlesQuery } from './queries';
import { contentPages } from './pages';
export function createContentModule(){return defineModule({name:'content',
  version: packageJson.version,
  baseVersionRange: '^1.0.0',
  dependencies: { required: [
    { name: 'platform', versionRange: '^0.1.0' },
    { name: 'customer', versionRange: '^0.1.0' },
  ] },
  data: { owns: ['content_articles', 'content_contact_messages'] },migrations:contentMigrations,events:contentEvents,permissions:[
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
 {descriptor:deleteArticleCommand,handler:deleteArticleHandler},
 {descriptor:submitContactMessageCommand,handler:submitContactMessageHandler},
 {descriptor:markContactMessageHandledCommand,handler:markContactMessageHandledHandler},
],queries:[
 {descriptor:listArticlesQuery,handler:listArticlesHandler},
 {descriptor:getArticleQuery,handler:getArticleHandler},
 {descriptor:listPublishedArticlesQuery,handler:listPublishedArticlesHandler},
 {descriptor:getPublishedArticleQuery,handler:getPublishedArticleHandler},
 {descriptor:getPublishedKindsQuery,handler:getPublishedKindsHandler},
 {descriptor:listContactMessagesQuery,handler:listContactMessagesHandler},
 {descriptor:getContactMessageQuery,handler:getContactMessageHandler},
],pages:contentPages});}
