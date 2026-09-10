import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import { CUSTOMER_ROLE, accountService, hashPassword } from '@storeweave/identity';
import { sql } from 'drizzle-orm';
import { customerDto, setCustomerStatusInput, registerCustomerInput, registerCustomerOutput, setCustomerBirthdayInput, updateMyProfileInput } from './dto';
import { customerRegisteredV1 } from './events';
import { CustomerRepository, toCustomerDto } from './repository';
import { customerService } from './service';

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
    passwordHash: await hashPassword(input.password),
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

  await ctx.publish({
    name: customerRegisteredV1.name,
    payload: {
      customerId: row.id,
      accountId: account.id,
      displayName,
      registeredAt: ctx.now,
    },
  });

  return { customer: toCustomerDto(row), accountId: account.id, email: account.email };
};

export const updateMyProfileCommand = defineCommand({
  name: 'commerce.customer.updateMyProfile',
  summary: '維護自己的個人資料與收件地址',
  input: updateMyProfileInput,
  output: customerDto,
  permission: 'customer:write',
  idempotency: 'optional',
  audit: {
    action: 'customer.profile-updated',
    resourceType: 'customer',
    resourceId: (_i, o: z.infer<typeof customerDto>) => o.id,
    // 只記「改了哪些欄位」，不記內容：電話與地址是個資，稽核紀錄不該變成第二份個資庫。
    redact: (i: z.infer<typeof updateMyProfileInput>) => ({ fields: Object.keys(i).sort() }),
  },
});

export const updateMyProfileHandler = async (
  input: z.infer<typeof updateMyProfileInput>,
  ctx: CommandContext,
) => {
  const me = await customerService.requireByActor(ctx.tx, ctx.actor);
  const current = await repository.findById(ctx.tx, me.customerId);
  if (!current) throw PlatformError.notFound('Customer', me.customerId);

  if (input.birthday !== undefined && current.birthday !== null && current.birthday !== input.birthday) {
    // 生日是生日禮券的依據。放任自行修改等於讓人每個月換一次生日領一次券。
    throw PlatformError.validation('birthday can only be set once; contact support to correct it');
  }

  if (input.displayName !== undefined) {
    // 頁首與 /auth/me 讀的是帳號上的名字，只改顧客那一份會讓兩邊永遠分岔。
    await accountService.setDisplayName(ctx.tx, me.accountId, input.displayName);
  }

  const row = await repository.update(ctx.tx, me.customerId, {
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.phone === undefined ? {} : { phone: input.phone }),
    ...(input.birthday === undefined ? {} : { birthday: input.birthday }),
    ...(input.address === undefined ? {} : {
      addressRecipient: input.address.recipient,
      addressPhone: input.address.phone,
      addressCountryCode: input.address.countryCode,
      addressPostcode: input.address.postcode,
      addressCity: input.address.city,
      addressDistrict: input.address.district,
      addressLine1: input.address.line1,
      addressLine2: input.address.line2,
    }),
    updatedAt: ctx.now,
  });
  if (!row) throw PlatformError.notFound('Customer', me.customerId);
  return toCustomerDto(row);
};

export const setCustomerBirthdayCommand = defineCommand({
  name: 'commerce.customer.setCustomerBirthday',
  summary: '客服代為修正會員生日',
  input: setCustomerBirthdayInput,
  output: customerDto,
  // 顧客自己沒有這個權限：這正是「要改得找客服」的實作方式。
  permission: 'customers:manage',
  idempotency: 'optional',
  // 稽核由 handler 自己寫：原值只有 handler 讀得到，而宣告式的 redact 只拿得到 input。
});

export const setCustomerBirthdayHandler = async (
  input: z.infer<typeof setCustomerBirthdayInput>,
  ctx: CommandContext,
) => {
  // 鎖住再讀：原值要進稽核紀錄，兩位客服同時更正時不鎖會讓兩筆紀錄記下同一個原值，
  // 其中一筆就把另一次更正蓋掉的東西寫錯了。
  const before = await repository.lockById(ctx.tx, input.customerId);
  if (!before) throw PlatformError.notFound('Customer', input.customerId);
  const row = await repository.update(ctx.tx, input.customerId, { birthday: input.birthday, updatedAt: ctx.now });
  if (!row) throw PlatformError.notFound('Customer', input.customerId);
  await ctx.audit({
    action: 'customer.birthday-corrected',
    resourceType: 'customer',
    resourceId: input.customerId,
    payload: { birthday: input.birthday, reason: input.reason, previousBirthday: before.birthday ?? null },
  });
  return toCustomerDto(row);
};

export const setCustomerStatusCommand = defineCommand({
  name: 'commerce.customer.setCustomerStatus',
  summary: '後台：停用或啟用會員',
  input: setCustomerStatusInput,
  output: customerDto,
  permission: 'customers:manage',
  idempotency: 'optional',
  audit: {
    action: 'customer.status-changed',
    resourceType: 'customer',
    resourceId: (i: z.infer<typeof setCustomerStatusInput>) => i.customerId,
    redact: (i: z.infer<typeof setCustomerStatusInput>) => ({ status: i.status }),
  },
});

export const setCustomerStatusHandler = async (
  input: z.infer<typeof setCustomerStatusInput>,
  ctx: CommandContext,
) => {
  const row = await repository.update(ctx.tx, input.customerId, { status: input.status, updatedAt: ctx.now });
  if (!row) throw PlatformError.notFound('Customer', input.customerId);

  // 帳號一起停：只停顧客資料的話，人還是登得進來，只是什麼都不能做——那不是「停用帳號」。
  // 走 identity 的入口而不是自己 UPDATE：那兩張表是 identity 擁有的。
  await accountService.setStatus(ctx.tx, row.accountId, input.status === 'disabled' ? 'disabled' : 'active');

  return toCustomerDto(row);
};
