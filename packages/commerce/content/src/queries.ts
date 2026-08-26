import type { z } from 'zod';
import { PlatformError,defineQuery,type QueryContext } from '@storeweave/contracts';
import { articleDto,articleIdInput,contactMessageDto,emptyInput,getPublishedArticleInput,listArticlesInput,listArticlesOutput,listContactMessagesInput,listContactMessagesOutput,listPublishedArticlesInput,listPublishedArticlesOutput,publishedKindsOutput } from './dto';
import { ContentRepository,toArticleDto } from './repository';
const repository=new ContentRepository();

export const listArticlesQuery=defineQuery({name:'commerce.content.listArticles',summary:'列出品牌內容（含草稿）',input:listArticlesInput,output:listArticlesOutput,permission:'content:read'});
export const listArticlesHandler=async(input:z.infer<typeof listArticlesInput>,ctx:QueryContext)=>repository.list(ctx.db,input);
export const getArticleQuery=defineQuery({name:'commerce.content.getArticle',summary:'取得品牌內容（含草稿）',input:articleIdInput,output:articleDto,permission:'content:read'});
export const getArticleHandler=async(input:z.infer<typeof articleIdInput>,ctx:QueryContext)=>{const row=await repository.findById(ctx.db,input.id);if(!row)throw PlatformError.notFound('Article',input.id);return toArticleDto(row);};

/**
 * The storefront gets its own pair of queries rather than a flag on the staff
 * ones: "only published" is an invariant of the public surface, and it must not
 * depend on every caller remembering to pass it.
 */
export const listPublishedArticlesQuery=defineQuery({name:'commerce.content.listPublishedArticles',summary:'列出已發布的品牌內容',input:listPublishedArticlesInput,output:listPublishedArticlesOutput,permission:'content:public-read'});
export const listPublishedArticlesHandler=async(input:z.infer<typeof listPublishedArticlesInput>,ctx:QueryContext)=>({items:await repository.listPublished(ctx.db,input.kind,input.limit)});
export const getPublishedArticleQuery=defineQuery({name:'commerce.content.getPublishedArticle',summary:'取得一篇已發布的品牌內容',input:getPublishedArticleInput,output:articleDto,permission:'content:public-read'});
export const getPublishedArticleHandler=async(input:z.infer<typeof getPublishedArticleInput>,ctx:QueryContext)=>{const article=await repository.findPublished(ctx.db,input.kind,input.slug);if(!article)throw PlatformError.notFound('Article',`${input.kind}/${input.slug}`);return article;};

/** One grouped read so the site navigation does not cost four queries per page. */
export const getPublishedKindsQuery=defineQuery({name:'commerce.content.getPublishedKinds',summary:'哪幾種品牌內容已經有發布的文章',input:emptyInput,output:publishedKindsOutput,permission:'content:public-read'});
export const getPublishedKindsHandler=async(_input:unknown,ctx:QueryContext)=>({kinds:await repository.publishedKinds(ctx.db)});

export const listContactMessagesQuery=defineQuery({name:'commerce.content.listContactMessages',summary:'列出聯絡訊息',input:listContactMessagesInput,output:listContactMessagesOutput,permission:'contact:read'});
export const listContactMessagesHandler=async(input:z.infer<typeof listContactMessagesInput>,ctx:QueryContext)=>repository.listContactMessages(ctx.db,input);
export const getContactMessageQuery=defineQuery({name:'commerce.content.getContactMessage',summary:'取得一則聯絡訊息',input:articleIdInput,output:contactMessageDto,permission:'contact:read'});
export const getContactMessageHandler=async(input:z.infer<typeof articleIdInput>,ctx:QueryContext)=>{const row=await repository.findContactMessage(ctx.db,input.id);if(!row)throw PlatformError.notFound('ContactMessage',input.id);return row;};
