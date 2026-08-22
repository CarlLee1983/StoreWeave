import { z } from 'zod';
import { PlatformError, defineQuery, type QueryContext } from '@storeweave/contracts';
import { sql } from 'drizzle-orm';
import {
  adminCustomerDetailDto,
  customerDto,
  listCustomersInput,
  listCustomersOutput,
} from './dto';
import { CustomerRepository, toCustomerDto } from './repository';
import { customerService } from './service';

const repository = new CustomerRepository();

export const getMyProfileQuery = defineQuery({
  name: 'commerce.customer.getMyProfile',
  summary: '讀取自己的個人資料',
  input: z.object({}).strict(),
  output: customerDto,
  permission: 'customer:read',
});

/** 「我的」由 actor 決定，不收 id：收了就等於開一條讀別人資料的路。 */
export const getMyProfileHandler = async (_input: unknown, ctx: QueryContext) => {
  const me = await customerService.requireByActor(ctx.db, ctx.actor);
  const row = await repository.findById(ctx.db, me.customerId);
  if (!row) throw PlatformError.notFound('Customer', me.customerId);
  return toCustomerDto(row);
};

export const listCustomersQuery = defineQuery({
  name: 'commerce.customer.listCustomers',
  summary: '後台：列出會員',
  input: listCustomersInput,
  output: listCustomersOutput,
  permission: 'customers:manage',
});

export const listCustomersHandler = async (input: z.infer<typeof listCustomersInput>, ctx: QueryContext) => {
  const { items, total } = await repository.listForAdmin(ctx.db, input);
  return { items: items.map((row) => ({ ...toCustomerDto(row), email: row.email })), total };
};

export const getCustomerQuery = defineQuery({
  name: 'commerce.customer.getCustomer',
  summary: '後台：單一會員的資料與訂單',
  input: z.object({ id: z.string().uuid() }).strict(),
  output: adminCustomerDetailDto,
  permission: 'customers:manage',
});

export const getCustomerHandler = async (input: { id: string }, ctx: QueryContext) => {
  const row = await repository.findById(ctx.db, input.id);
  if (!row) throw PlatformError.notFound('Customer', input.id);

  const account = await ctx.db.execute<{ email: string }>(sql`
    SELECT email FROM platform_users WHERE id = ${row.accountId}
  `);
  // 訂單屬於 order 模組的資料表，這裡只讀它的公開欄位，不碰金額計算。
  const orders = await ctx.db.execute<{
    id: string; number: string; status: string; currency: string; total_cents: number; placed_at: Date;
  }>(sql`
    SELECT id, number, status, currency, total_cents, placed_at
    FROM order_orders WHERE customer_id = ${row.id} ORDER BY placed_at DESC LIMIT 100
  `);

  return {
    ...toCustomerDto(row),
    email: account.rows[0]?.email ?? '',
    orders: orders.rows.map((o) => ({
      id: o.id,
      number: o.number,
      status: o.status,
      currency: o.currency,
      totalCents: o.total_cents,
      placedAt: o.placed_at,
    })),
  };
};
