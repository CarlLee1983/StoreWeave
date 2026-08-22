import { and, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { customers, type CustomerRow } from './schema';
import type { CustomerDto } from './dto';

export function toCustomerDto(row: CustomerRow): CustomerDto {
  return {
    id: row.id,
    accountId: row.accountId,
    displayName: row.displayName,
    birthday: row.birthday,
    phone: row.phone,
    address: row.addressLine1
      ? {
          recipient: row.addressRecipient ?? '',
          phone: row.addressPhone ?? '',
          postcode: row.addressPostcode ?? '',
          city: row.addressCity ?? '',
          line1: row.addressLine1,
          line2: row.addressLine2,
        }
      : null,
    status: row.status as CustomerDto['status'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CustomerListRow extends CustomerRow {
  email: string;
}

export class CustomerRepository {
  async insert(tx: Tx, values: typeof customers.$inferInsert): Promise<CustomerRow> {
    const [row] = await tx.insert(customers).values(values).returning();
    return row;
  }

  async update(tx: Tx, id: string, values: Partial<typeof customers.$inferInsert>): Promise<CustomerRow | null> {
    const [row] = await tx.update(customers).set(values).where(eq(customers.id, id)).returning();
    return row ?? null;
  }

  async findById(db: DrizzleDb | Tx, id: string): Promise<CustomerRow | null> {
    const [row] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * 後台清單。email 屬於帳號、顯示名稱屬於顧客，兩邊都要搜得到，
   * 因此這一支是 customer 模組唯一讀 platform_users 的地方——而且只讀，不寫。
   */
  async listForAdmin(
    db: DrizzleDb | Tx,
    filter: { q?: string; status?: string; limit: number; offset: number },
  ): Promise<{ items: CustomerListRow[]; total: number }> {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(customers.status, filter.status));
    if (filter.q) {
      const like = `%${filter.q}%`;
      conditions.push(or(ilike(customers.displayName, like), sql`u.email ILIKE ${like}`)!);
    }
    const where = conditions.length ? and(...conditions)! : sql`true`;

    const rows = await db
      .select({ customer: customers, email: sql<string>`u.email` })
      .from(customers)
      .innerJoin(sql`platform_users u`, sql`u.id = ${customers.accountId}`)
      .where(where)
      .orderBy(sql`${customers.createdAt} DESC`)
      .limit(filter.limit)
      .offset(filter.offset);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(customers)
      .innerJoin(sql`platform_users u`, sql`u.id = ${customers.accountId}`)
      .where(where);

    return {
      items: rows.map((r) => ({ ...r.customer, email: r.email })),
      total: Number(count),
    };
  }

  /**
   * 這些「月-日」當天生日的有效會員。傳多個月日是為了處理二月二十九日——
   * 平年沒有那一天，那批人的禮券在三月一日發。
   */
  async idsWithBirthdayOn(db: DrizzleDb | Tx, monthDays: readonly string[]): Promise<string[]> {
    if (monthDays.length === 0) return [];
    const rows = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(
        eq(customers.status, 'active'),
        inArray(sql`substring(${customers.birthday} from 6 for 5)`, [...monthDays]),
      )!)
      .orderBy(customers.id);
    return rows.map((row) => row.id);
  }

  /** 全體有效會員的識別。批次發券掃這一份清單。 */
  async activeIds(db: DrizzleDb | Tx): Promise<string[]> {
    const rows = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.status, 'active'))
      .orderBy(customers.createdAt, customers.id);
    return rows.map((row) => row.id);
  }

  async findByAccountId(db: DrizzleDb | Tx, accountId: string): Promise<CustomerRow | null> {
    const [row] = await db.select().from(customers).where(eq(customers.accountId, accountId)).limit(1);
    return row ?? null;
  }
}
