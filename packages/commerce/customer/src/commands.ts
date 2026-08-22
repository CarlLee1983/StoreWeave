import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineCommand, type CommandContext } from '@storeweave/contracts';
import { CUSTOMER_ROLE, accountService } from '@storeweave/identity';
import { registerCustomerInput, registerCustomerOutput } from './dto';
import { CustomerRepository, toCustomerDto } from './repository';

const repository = new CustomerRepository();

export const registerCustomerCommand = defineCommand({
  name: 'commerce.customer.registerCustomer',
  summary: '註冊成為會員',
  input: registerCustomerInput,
  output: registerCustomerOutput,
  // 註冊發生在顧客身分存在之前，因此由匿名訪客的身分執行。
  permission: 'customer:register',
  idempotency: 'optional',
  audit: {
    action: 'customer.registered',
    resourceType: 'customer',
    resourceId: (_i, o: z.infer<typeof registerCustomerOutput>) => o.customer.id,
    // email 是個資也是帳號枚舉的材料，不進稽核 payload。
    redact: () => ({}),
  },
});

export const registerCustomerHandler = async (
  input: z.infer<typeof registerCustomerInput>,
  ctx: CommandContext,
) => {
  const displayName = input.displayName?.trim() || input.email.split('@')[0];

  // 帳號與顧客資料同生共死：帳號建了但顧客資料沒建，會是一個登入得了卻不存在的會員。
  const account = await accountService.createAccount(ctx.tx, {
    email: input.email,
    password: input.password,
    displayName,
    role: CUSTOMER_ROLE,
  });

  const row = await repository.insert(ctx.tx, {
    id: randomUUID(),
    accountId: account.id,
    displayName,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });

  return { customer: toCustomerDto(row), accountId: account.id, email: account.email };
};
