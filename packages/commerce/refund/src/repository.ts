import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { refunds, type RefundRow } from './schema';
import type { RefundDto } from './dto';
export function toRefundDto(r: RefundRow): RefundDto { return { id:r.id,orderId:r.orderId,amountCents:r.amountCents,currency:r.currency,source:r.source as RefundDto['source'],sourceRef:r.sourceRef,originalPaymentAttemptRef:r.originalPaymentAttemptRef,paymentProvider:r.paymentProvider,reason:r.reason,requestedByActorId:r.requestedByActorId,status:r.status as RefundDto['status'],attemptNo:r.attemptNo,providerRequestRef:r.providerRequestRef,providerRefundRef:r.providerRefundRef,failureMessage:r.failureMessage,requestedAt:r.requestedAt,completedAt:r.completedAt,updatedAt:r.updatedAt }; }
export function toCustomerRefundDto(r: RefundRow) { return { id:r.id,orderId:r.orderId,amountCents:r.amountCents,currency:r.currency,status:r.status as 'requested'|'succeeded'|'failed',requestedAt:r.requestedAt,completedAt:r.completedAt }; }
export class RefundRepository {
 async findById(db:DrizzleDb|Tx,id:string){const [r]=await db.select().from(refunds).where(eq(refunds.id,id)).limit(1);return r??null;}
 async lockById(tx:Tx,id:string){const [r]=await tx.select().from(refunds).where(eq(refunds.id,id)).limit(1).for('update');return r??null;}
 async hasBlockingDirectRefund(tx:Tx,orderId:string){const [r]=await tx.select({id:refunds.id}).from(refunds).where(and(eq(refunds.orderId,orderId),eq(refunds.source,'direct'),sql`${refunds.status} IN ('requested', 'succeeded')`)).limit(1);return Boolean(r);}
 async hasDirectRefund(tx:Tx,orderId:string){const [r]=await tx.select({id:refunds.id}).from(refunds).where(and(eq(refunds.orderId,orderId),eq(refunds.source,'direct'))).limit(1);return Boolean(r);}
 async findRmaRefund(tx:Tx,rmaId:string){const [r]=await tx.select().from(refunds).where(and(eq(refunds.source,'rma'),eq(refunds.sourceRef,rmaId))).limit(1);return r??null;}
 async insert(tx:Tx,values:typeof refunds.$inferInsert){const [r]=await tx.insert(refunds).values(values).returning();return r;}
 async update(tx:Tx,id:string,values:Partial<typeof refunds.$inferInsert>,now:Date){const [r]=await tx.update(refunds).set({...values,updatedAt:now}).where(eq(refunds.id,id)).returning();return r??null;}
 async list(db:DrizzleDb,filter:{orderId?:string;customerId?:string;status?:string;limit:number;offset:number}){const c:SQL[]=[];if(filter.orderId)c.push(eq(refunds.orderId,filter.orderId));if(filter.customerId)c.push(eq(refunds.customerId,filter.customerId));if(filter.status)c.push(eq(refunds.status,filter.status));const where=c.length?and(...c)!:sql`true`;const rows=await db.select().from(refunds).where(where).orderBy(desc(refunds.requestedAt),desc(refunds.id)).limit(filter.limit).offset(filter.offset);const [{count}]=await db.select({count:sql<number>`count(*)::int`}).from(refunds).where(where);return{rows,total:Number(count)};}
}
