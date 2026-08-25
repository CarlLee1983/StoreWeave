import { and, desc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { lifecycleDeliveries, type LifecycleDeliveryRow } from './schema';
import type { LifecycleDeliveryDto } from './dto';

export function toLifecycleDeliveryDto(row: LifecycleDeliveryRow): LifecycleDeliveryDto {
  return {
    id: row.id, eventId: row.eventId, orderId: row.orderId, template: row.template as LifecycleDeliveryDto['template'],
    reference: row.reference, recipientEmail: row.recipientEmail, variables: row.variables,
    status: row.status as LifecycleDeliveryDto['status'], providerRef: row.providerRef, attempts: row.attempts,
    lastError: row.lastError, sentAt: row.sentAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

export class NotificationRepository {
  async findByEventTemplate(db: DrizzleDb | Tx, eventId: string, template: string): Promise<LifecycleDeliveryRow | null> {
    const [row] = await db.select().from(lifecycleDeliveries)
      .where(and(eq(lifecycleDeliveries.eventId, eventId), eq(lifecycleDeliveries.template, template))).limit(1);
    return row ?? null;
  }

  async findById(db: DrizzleDb | Tx, id: string): Promise<LifecycleDeliveryRow | null> {
    const [row] = await db.select().from(lifecycleDeliveries).where(eq(lifecycleDeliveries.id, id)).limit(1);
    return row ?? null;
  }

  async lockById(tx: Tx, id: string): Promise<LifecycleDeliveryRow | null> {
    const [row] = await tx.select().from(lifecycleDeliveries).where(eq(lifecycleDeliveries.id, id)).limit(1).for('update');
    return row ?? null;
  }

  async insert(tx: Tx, values: typeof lifecycleDeliveries.$inferInsert): Promise<LifecycleDeliveryRow | null> {
    const [row] = await tx.insert(lifecycleDeliveries).values(values).onConflictDoNothing().returning();
    return row ?? null;
  }

  async update(tx: Tx, id: string, values: Partial<typeof lifecycleDeliveries.$inferInsert>): Promise<LifecycleDeliveryRow | null> {
    const [row] = await tx.update(lifecycleDeliveries).set(values).where(eq(lifecycleDeliveries.id, id)).returning();
    return row ?? null;
  }

  async list(db: DrizzleDb, filter: { orderId?: string; status?: string; limit: number; offset: number }) {
    const conditions = [filter.orderId ? eq(lifecycleDeliveries.orderId, filter.orderId) : undefined, filter.status ? eq(lifecycleDeliveries.status, filter.status) : undefined].filter(Boolean) as any[];
    const where = conditions.length ? and(...conditions) : sql`true`;
    const items = await db.select().from(lifecycleDeliveries).where(where).orderBy(desc(lifecycleDeliveries.createdAt)).limit(filter.limit).offset(filter.offset);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(lifecycleDeliveries).where(where);
    return { items, total: Number(count) };
  }
}
