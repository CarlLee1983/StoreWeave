import { and, asc, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { contentArticles,contentContactMessages,type ContentArticleRow,type ContentContactMessageRow } from './schema';
import type { ArticleDto,ArticleKind,ContactMessageDto } from './dto';
export function toArticleDto(row:ContentArticleRow):ArticleDto{return{id:row.id,kind:row.kind as ArticleKind,slug:row.slug,title:row.title,summary:row.summary,section:row.section,body:row.body??[],imageKey:row.imageKey,mediaAssetId:row.mediaAssetId,position:row.position,status:row.status as ArticleDto['status'],publishedAt:row.publishedAt,createdAt:row.createdAt,updatedAt:row.updatedAt};}
export function toContactMessageDto(row:ContentContactMessageRow):ContactMessageDto{return{id:row.id,customerId:row.customerId,name:row.name,email:row.email,subject:row.subject,message:row.message,status:row.status as ContactMessageDto['status'],handledByActorId:row.handledByActorId,handledAt:row.handledAt,createdAt:row.createdAt};}
/** Newest first only breaks ties: a merchant-set position is the primary order. */
/**
 * The table's CHECK ties `status` to `published_at`. Saying the same thing in the
 * update signature means a caller cannot set one without the other: the rule is
 * caught by the compiler instead of by a failing statement at runtime.
 */
type ArticleUpdate =
  | { status:'published'; publishedAt:Date }
  | { status:'draft'; publishedAt:null }
  | Omit<Partial<typeof contentArticles.$inferInsert>,'status'|'publishedAt'>;

const listingOrder=[asc(contentArticles.position),desc(contentArticles.publishedAt),desc(contentArticles.createdAt)] as const;

export class ContentRepository {
 async findById(db:DrizzleDb|Tx,id:string){const [row]=await db.select().from(contentArticles).where(eq(contentArticles.id,id)).limit(1);return row??null;}
 async lockById(tx:Tx,id:string){const [row]=await tx.select().from(contentArticles).where(eq(contentArticles.id,id)).limit(1).for('update');return row??null;}
 /** `exceptId` lets an update keep its own slug while still refusing a taken one. */
 async slugTaken(tx:Tx,kind:string,slug:string,exceptId?:string){const where=[eq(contentArticles.kind,kind),eq(contentArticles.slug,slug)];if(exceptId)where.push(ne(contentArticles.id,exceptId));const [row]=await tx.select({id:contentArticles.id}).from(contentArticles).where(and(...where)).limit(1);return row!==undefined;}
 async insert(tx:Tx,values:typeof contentArticles.$inferInsert){const [row]=await tx.insert(contentArticles).values(values).returning();return row;}
 async update(tx:Tx,id:string,values:ArticleUpdate,now:Date){const [row]=await tx.update(contentArticles).set({...values,updatedAt:now}).where(eq(contentArticles.id,id)).returning();return row??null;}
 async remove(tx:Tx,id:string){const [row]=await tx.delete(contentArticles).where(eq(contentArticles.id,id)).returning();return row??null;}
 async list(db:DrizzleDb,filter:{kind?:string;status?:string;limit:number;offset:number}){const where:SQL[]=[];if(filter.kind)where.push(eq(contentArticles.kind,filter.kind));if(filter.status)where.push(eq(contentArticles.status,filter.status));const condition=where.length?and(...where)!:sql`true`;const rows=await db.select().from(contentArticles).where(condition).orderBy(...listingOrder).limit(filter.limit).offset(filter.offset);const [{count}]=await db.select({count:sql<number>`count(*)::int`}).from(contentArticles).where(condition);return{items:rows.map(toArticleDto),total:Number(count)};}
 /** Which kinds have at least one published article; the nav needs this once per render. */
 async publishedKinds(db:DrizzleDb){const rows=await db.selectDistinct({kind:contentArticles.kind}).from(contentArticles).where(eq(contentArticles.status,'published'));return rows.map(row=>row.kind);}
 async listPublished(db:DrizzleDb,kind:string,limit:number,offset:number){const condition=and(eq(contentArticles.kind,kind),eq(contentArticles.status,'published'));const rows=await db.select().from(contentArticles).where(condition).orderBy(...listingOrder).limit(limit).offset(offset);const [{count}]=await db.select({count:sql<number>`count(*)::int`}).from(contentArticles).where(condition);return{items:rows.map(toArticleDto),total:Number(count)};}
 async listPublishedSiteContent(db:DrizzleDb,limit:number,offset:number){const condition=eq(contentArticles.status,'published');const rows=await db.select().from(contentArticles).where(condition).orderBy(...listingOrder).limit(limit).offset(offset);const [{count}]=await db.select({count:sql<number>`count(*)::int`}).from(contentArticles).where(condition);return{items:rows.map(toArticleDto),total:Number(count)};}
 async findPublished(db:DrizzleDb,kind:string,slug:string){const [row]=await db.select().from(contentArticles).where(and(eq(contentArticles.kind,kind),eq(contentArticles.slug,slug),eq(contentArticles.status,'published'))).limit(1);return row?toArticleDto(row):null;}
 async hasPublishedMedia(db:DrizzleDb,mediaAssetId:string){const [row]=await db.select({mediaAssetId:contentArticles.mediaAssetId}).from(contentArticles).where(and(eq(contentArticles.mediaAssetId,mediaAssetId),eq(contentArticles.status,'published'))).limit(1);return row?.mediaAssetId??null;}

 async insertContactMessage(tx:Tx,values:typeof contentContactMessages.$inferInsert){const [row]=await tx.insert(contentContactMessages).values(values).returning();return row;}
 async lockContactMessage(tx:Tx,id:string){const [row]=await tx.select().from(contentContactMessages).where(eq(contentContactMessages.id,id)).limit(1).for('update');return row??null;}
 async updateContactMessage(tx:Tx,id:string,values:Partial<typeof contentContactMessages.$inferInsert>){const [row]=await tx.update(contentContactMessages).set(values).where(eq(contentContactMessages.id,id)).returning();return row??null;}
 async findContactMessage(db:DrizzleDb|Tx,id:string){const [row]=await db.select().from(contentContactMessages).where(eq(contentContactMessages.id,id)).limit(1);return row?toContactMessageDto(row):null;}
 async listContactMessages(db:DrizzleDb,filter:{status?:string;limit:number;offset:number}){const condition=filter.status?eq(contentContactMessages.status,filter.status):sql`true`;const rows=await db.select().from(contentContactMessages).where(condition).orderBy(desc(contentContactMessages.createdAt),desc(contentContactMessages.id)).limit(filter.limit).offset(filter.offset);const [{count}]=await db.select({count:sql<number>`count(*)::int`}).from(contentContactMessages).where(condition);return{items:rows.map(toContactMessageDto),total:Number(count)};}
}
