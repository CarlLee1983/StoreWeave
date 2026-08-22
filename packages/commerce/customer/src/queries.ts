import { z } from 'zod';
import { PlatformError, defineQuery, type QueryContext } from '@storeweave/contracts';
import { customerDto } from './dto';
import { CustomerRepository, toCustomerDto } from './repository';
import { customerService } from './service';

const repository = new CustomerRepository();

export const getMyProfileQuery = defineQuery({
  name: 'commerce.customer.getMyProfile',
  summary: '讀取自己的個人資料',
  input: z.object({}),
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
