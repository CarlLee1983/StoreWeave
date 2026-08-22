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

  async findByAccountId(db: DrizzleDb | Tx, accountId: string): Promise<CustomerRow | null> {
    const [row] = await db.select().from(customers).where(eq(customers.accountId, accountId)).limit(1);
    return row ?? null;
  }
}
