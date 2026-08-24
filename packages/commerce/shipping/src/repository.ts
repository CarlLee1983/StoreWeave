import { asc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { shipments, shippingMethods, type ShipmentRow, type ShippingMethodRow } from './schema';
import type { ShipmentDto, ShippingMethodDto } from './dto';

export function toShippingMethodDto(row: ShippingMethodRow): ShippingMethodDto {
  return {
    id: row.id, code: row.code, name: row.name, provider: row.provider, type: row.type, destinationKind: row.destinationKind as ShippingMethodDto['destinationKind'],
    feeCents: row.feeCents, freeShippingThresholdCents: row.freeShippingThresholdCents,
    enabled: row.enabled, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

/** Deliberately does not map `providerStatusRaw`; it is private operational evidence. */
export function toShipmentDto(row: ShipmentRow): ShipmentDto {
  return {
    id: row.id, orderId: row.orderId, shippingMethodId: row.shippingMethodId,
    provider: row.provider, type: row.type, providerRef: row.providerRef, trackingNumber: row.trackingNumber,
    status: row.status as ShipmentDto['status'], createdAt: row.createdAt, shippedAt: row.shippedAt,
    arrivedAt: row.arrivedAt, completedAt: row.completedAt, updatedAt: row.updatedAt,
  };
}

export class ShippingRepository {
  async insertMethod(tx: Tx, values: typeof shippingMethods.$inferInsert): Promise<ShippingMethodRow> {
    const [row] = await tx.insert(shippingMethods).values(values).returning();
    return row;
  }

  async updateMethod(tx: Tx, id: string, values: Partial<typeof shippingMethods.$inferInsert>, now: Date): Promise<ShippingMethodRow | null> {
    const [row] = await tx.update(shippingMethods).set({ ...values, updatedAt: now }).where(eq(shippingMethods.id, id)).returning();
    return row ?? null;
  }

  async findMethodById(db: DrizzleDb | Tx, id: string): Promise<ShippingMethodRow | null> {
    const [row] = await db.select().from(shippingMethods).where(eq(shippingMethods.id, id)).limit(1);
    return row ?? null;
  }

  async findMethodByCode(db: DrizzleDb | Tx, code: string): Promise<ShippingMethodRow | null> {
    const [row] = await db.select().from(shippingMethods).where(eq(shippingMethods.code, code)).limit(1);
    return row ?? null;
  }

  async listMethods(db: DrizzleDb, filter: { enabled?: boolean; limit: number; offset: number }) {
    const where = filter.enabled === undefined ? sql`true` : eq(shippingMethods.enabled, filter.enabled);
    const items = await db.select().from(shippingMethods).where(where).orderBy(asc(shippingMethods.code)).limit(filter.limit).offset(filter.offset);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(shippingMethods).where(where);
    return { items, total: Number(count) };
  }

  async insertShipment(tx: Tx, values: typeof shipments.$inferInsert): Promise<ShipmentRow> {
    const [row] = await tx.insert(shipments).values(values).returning();
    return row;
  }

  async findShipmentById(db: DrizzleDb | Tx, id: string): Promise<ShipmentRow | null> {
    const [row] = await db.select().from(shipments).where(eq(shipments.id, id)).limit(1);
    return row ?? null;
  }

  /** A shipment starts fulfilment; cancellation must not race it after locking Order. */
  async hasShipmentForOrder(db: DrizzleDb | Tx, orderId: string): Promise<boolean> {
    const [row] = await db.select({ id: shipments.id }).from(shipments).where(eq(shipments.orderId, orderId)).limit(1);
    return Boolean(row);
  }

  /** State transitions lock their aggregate so duplicate callbacks cannot publish duplicate stages. */
  async lockShipment(tx: Tx, id: string): Promise<ShipmentRow | null> {
    const [row] = await tx.select().from(shipments).where(eq(shipments.id, id)).limit(1).for('update');
    return row ?? null;
  }

  async updateShipment(tx: Tx, id: string, values: Partial<typeof shipments.$inferInsert>, now: Date): Promise<ShipmentRow | null> {
    const [row] = await tx.update(shipments).set({ ...values, updatedAt: now }).where(eq(shipments.id, id)).returning();
    return row ?? null;
  }
}
