import { and, asc, eq, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { products, type ProductRow } from './schema';
import type { ProductDto } from './dto';

export function toProductDto(row: ProductRow): ProductDto {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    priceCents: row.priceCents,
    currency: row.currency,
    status: row.status as ProductDto['status'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ProductRepository {
  async insert(tx: Tx, values: typeof products.$inferInsert): Promise<ProductRow> {
    const [row] = await tx.insert(products).values(values).returning();
    return row;
  }

  async update(tx: Tx, id: string, values: Partial<typeof products.$inferInsert>): Promise<ProductRow | null> {
    const [row] = await tx.update(products).set({ ...values, updatedAt: new Date() }).where(eq(products.id, id)).returning();
    return row ?? null;
  }

  async findById(db: DrizzleDb | Tx, id: string): Promise<ProductRow | null> {
    const [row] = await db.select().from(products).where(eq(products.id, id)).limit(1);
    return row ?? null;
  }

  async findBySku(db: DrizzleDb | Tx, sku: string): Promise<ProductRow | null> {
    const [row] = await db.select().from(products).where(eq(products.sku, sku)).limit(1);
    return row ?? null;
  }

  async search(
    db: DrizzleDb,
    filter: { q?: string; status?: string; minPriceCents?: number; maxPriceCents?: number; limit: number; offset: number },
  ): Promise<{ items: ProductRow[]; total: number }> {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(products.status, filter.status));
    if (filter.minPriceCents !== undefined) conditions.push(gte(products.priceCents, filter.minPriceCents));
    if (filter.maxPriceCents !== undefined) conditions.push(lte(products.priceCents, filter.maxPriceCents));
    if (filter.q) {
      const like = `%${filter.q}%`;
      conditions.push(or(ilike(products.name, like), ilike(products.sku, like))!);
    }
    const where = conditions.length ? and(...conditions)! : sql`true`;
    // A secondary key keeps offset pages stable when a batch shares the same timestamp.
    const items = await db.select().from(products).where(where).orderBy(asc(products.createdAt), asc(products.id)).limit(filter.limit).offset(filter.offset);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(products).where(where);
    return { items, total: Number(count) };
  }
}
