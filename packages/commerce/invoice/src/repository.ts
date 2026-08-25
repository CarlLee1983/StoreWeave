import { and, desc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { invoices, type InvoiceRow } from './schema';
import type { InvoiceDto } from './dto';

export function toInvoiceDto(row: InvoiceRow): InvoiceDto {
  return { id: row.id, orderId: row.orderId, orderNumber: row.orderNumber, provider: row.provider, reference: row.reference, currency: row.currency,
    amountCents: row.amountCents, taxCents: row.taxCents, carrier: row.carrier as InvoiceDto['carrier'],
    status: row.status as InvoiceDto['status'], providerRef: row.providerRef, invoiceNumber: row.invoiceNumber,
    invoiceDate: row.invoiceDate, issueAttempts: row.issueAttempts, voidAttempts: row.voidAttempts, lastError: row.lastError,
    issuedAt: row.issuedAt, voidedAt: row.voidedAt, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export class InvoiceRepository {
  async findById(db: DrizzleDb | Tx, id: string): Promise<InvoiceRow | null> { const [row] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1); return row ?? null; }
  async findByOrderId(db: DrizzleDb | Tx, orderId: string): Promise<InvoiceRow | null> { const [row] = await db.select().from(invoices).where(eq(invoices.orderId, orderId)).limit(1); return row ?? null; }
  async findByEventId(db: DrizzleDb | Tx, eventId: string): Promise<InvoiceRow | null> { const [row] = await db.select().from(invoices).where(eq(invoices.eventId, eventId)).limit(1); return row ?? null; }
  async lockById(tx: Tx, id: string): Promise<InvoiceRow | null> { const [row] = await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1).for('update'); return row ?? null; }
  async insert(tx: Tx, values: typeof invoices.$inferInsert): Promise<InvoiceRow | null> { const [row] = await tx.insert(invoices).values(values).onConflictDoNothing().returning(); return row ?? null; }
  async update(tx: Tx, id: string, values: Partial<typeof invoices.$inferInsert>): Promise<InvoiceRow | null> { const [row] = await tx.update(invoices).set(values).where(eq(invoices.id, id)).returning(); return row ?? null; }
  async list(db: DrizzleDb, filter: { orderId?: string; status?: string; limit: number; offset: number }) {
    const conditions = [filter.orderId ? eq(invoices.orderId, filter.orderId) : undefined, filter.status ? eq(invoices.status, filter.status) : undefined].filter(Boolean) as any[];
    const where = conditions.length ? and(...conditions) : sql`true`;
    const items = await db.select().from(invoices).where(where).orderBy(desc(invoices.createdAt)).limit(filter.limit).offset(filter.offset);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(invoices).where(where);
    return { items, total: Number(count) };
  }
}
