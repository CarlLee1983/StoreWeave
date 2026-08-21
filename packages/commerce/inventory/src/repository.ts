import { randomUUID } from 'node:crypto';
import { asc, sql } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { stock } from './schema';
import type { StockDto } from './dto';

export interface StockSnapshot {
  productId: string;
  onHand: number;
  reserved: number;
  updatedAt: Date;
}

export function toStockDto(row: StockSnapshot): StockDto {
  return {
    productId: row.productId,
    onHand: row.onHand,
    reserved: row.reserved,
    available: row.onHand - row.reserved,
    updatedAt: row.updatedAt,
  };
}

export class StockRepository {
  /** 取得並鎖定庫存列；不存在時建立為 0。併發扣減靠這個 row lock 序列化。 */
  async lockOrCreate(tx: Tx, productId: string): Promise<StockSnapshot> {
    await tx.execute(sql`
      INSERT INTO inventory_stock (product_id, on_hand, reserved) VALUES (${productId}, 0, 0)
      ON CONFLICT (product_id) DO NOTHING
    `);
    const res = await tx.execute<{ product_id: string; on_hand: number; reserved: number; updated_at: Date }>(sql`
      SELECT product_id, on_hand, reserved, updated_at FROM inventory_stock WHERE product_id = ${productId} FOR UPDATE
    `);
    const row = res.rows[0];
    return { productId: row.product_id, onHand: row.on_hand, reserved: row.reserved, updatedAt: row.updated_at };
  }

  async applyDelta(tx: Tx, productId: string, delta: number): Promise<StockSnapshot> {
    const res = await tx.execute<{ product_id: string; on_hand: number; reserved: number; updated_at: Date }>(sql`
      UPDATE inventory_stock SET on_hand = on_hand + ${delta}, updated_at = now()
      WHERE product_id = ${productId}
      RETURNING product_id, on_hand, reserved, updated_at
    `);
    const row = res.rows[0];
    return { productId: row.product_id, onHand: row.on_hand, reserved: row.reserved, updatedAt: row.updated_at };
  }

  async recordMovement(
    tx: Tx,
    input: { productId: string; delta: number; reason: string; reference?: string | null; actorId: string },
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO inventory_movements (id, product_id, delta, reason, reference, actor_id)
      VALUES (${randomUUID()}, ${input.productId}, ${input.delta}, ${input.reason}, ${input.reference ?? null}, ${input.actorId})
    `);
  }

  async find(db: DrizzleDb | Tx, productId: string): Promise<StockSnapshot | null> {
    const [row] = await db.select().from(stock).where(sql`${stock.productId} = ${productId}`).limit(1);
    return row ? { productId: row.productId, onHand: row.onHand, reserved: row.reserved, updatedAt: row.updatedAt } : null;
  }

  async list(db: DrizzleDb, filter: { belowQuantity?: number; limit: number; offset: number }) {
    const where = filter.belowQuantity !== undefined
      ? sql`on_hand - reserved < ${filter.belowQuantity}`
      : sql`true`;
    const rows = await db.select().from(stock).where(where).orderBy(asc(stock.productId)).limit(filter.limit).offset(filter.offset);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(stock).where(where);
    return {
      items: rows.map((r) => ({ productId: r.productId, onHand: r.onHand, reserved: r.reserved, updatedAt: r.updatedAt })),
      total: Number(count),
    };
  }
}
