import { eq } from 'drizzle-orm';
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
    status: row.status as CustomerDto['status'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class CustomerRepository {
  async insert(tx: Tx, values: typeof customers.$inferInsert): Promise<CustomerRow> {
    const [row] = await tx.insert(customers).values(values).returning();
    return row;
  }

  async findByAccountId(db: DrizzleDb | Tx, accountId: string): Promise<CustomerRow | null> {
    const [row] = await db.select().from(customers).where(eq(customers.accountId, accountId)).limit(1);
    return row ?? null;
  }
}
