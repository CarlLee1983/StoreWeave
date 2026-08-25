import { and, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { rmaLines,rmas,type RmaLineRow,type RmaRow } from './schema';
import type { RmaDto } from './dto';
export function toRmaDto(row:RmaRow,lines:RmaLineRow[]):RmaDto{return{id:row.id,orderId:row.orderId,customerId:row.customerId,status:row.status as RmaDto['status'],resolution:'refund_and_reorder',reason:row.reason,requestedByActorId:row.requestedByActorId,staffNote:row.staffNote,refundId:row.refundId,receivedAt:row.receivedAt,completedAt:row.completedAt,createdAt:row.createdAt,updatedAt:row.updatedAt,lines:lines.map(line=>({id:line.id,orderLineId:line.orderLineId,productId:line.productId,sku:line.sku,name:line.name,quantity:line.quantity,unitPriceCents:line.unitPriceCents,lineTotalCents:line.lineTotalCents,discountCents:line.discountCents,disposition:line.disposition as 'restock'|'discard'|null,discardReason:line.discardReason}))};}
export class RmaRepository {
 async findById(db:DrizzleDb|Tx,id:string){const [row]=await db.select().from(rmas).where(eq(rmas.id,id)).limit(1);return row??null;}
 async lockById(tx:Tx,id:string){const [row]=await tx.select().from(rmas).where(eq(rmas.id,id)).limit(1).for('update');return row??null;}
 async linesFor(db:DrizzleDb|Tx,rmaId:string){return db.select().from(rmaLines).where(eq(rmaLines.rmaId,rmaId)).orderBy(rmaLines.id);}
 async insert(tx:Tx,values:typeof rmas.$inferInsert){const [row]=await tx.insert(rmas).values(values).returning();return row;}
 async insertLines(tx:Tx,values:(typeof rmaLines.$inferInsert)[]){if(values.length)await tx.insert(rmaLines).values(values);}
 async update(tx:Tx,id:string,values:Partial<typeof rmas.$inferInsert>,now:Date){const [row]=await tx.update(rmas).set({...values,updatedAt:now}).where(eq(rmas.id,id)).returning();return row??null;}
 async updateLine(tx:Tx,id:string,values:Partial<typeof rmaLines.$inferInsert>){const [row]=await tx.update(rmaLines).set(values).where(eq(rmaLines.id,id)).returning();return row??null;}
 /** Rejected cases are excluded, releasing their quantities for a new claim. */
 async claimedQuantity(tx:Tx,orderLineId:string){const [row]=await tx.select({quantity:sql<number>`coalesce(sum(${rmaLines.quantity}),0)::int`}).from(rmaLines).innerJoin(rmas,eq(rmaLines.rmaId,rmas.id)).where(and(eq(rmaLines.orderLineId,orderLineId),ne(rmas.status,'rejected')));return Number(row?.quantity??0);}
 async list(db:DrizzleDb,filter:{customerId?:string;orderId?:string;status?:string;limit:number;offset:number}){const where:SQL[]=[];if(filter.customerId)where.push(eq(rmas.customerId,filter.customerId));if(filter.orderId)where.push(eq(rmas.orderId,filter.orderId));if(filter.status)where.push(eq(rmas.status,filter.status));const condition=where.length?and(...where)!:sql`true`;const rows=await db.select().from(rmas).where(condition).orderBy(desc(rmas.createdAt),desc(rmas.id)).limit(filter.limit).offset(filter.offset);const [{count}]=await db.select({count:sql<number>`count(*)::int`}).from(rmas).where(condition);const items=await Promise.all(rows.map(async row=>toRmaDto(row,await this.linesFor(db,row.id))));return{items,total:Number(count)};}
}
