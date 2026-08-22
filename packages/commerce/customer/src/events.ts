import { z } from 'zod';
import { defineEvent } from '@storeweave/contracts';

/**
 * 新會員註冊。
 *
 * 刻意不帶 email：事件會被送到訂閱者手上、也會留在 outbox 裡，
 * 而 email 既是個資也是帳號枚舉的材料。需要它的訂閱者自己去問。
 */
export const customerRegisteredV1 = defineEvent({
  name: 'commerce.customer.registered.v1',
  summary: '新會員註冊',
  payload: z.object({
    customerId: z.string().uuid(),
    accountId: z.string().uuid(),
    displayName: z.string(),
    registeredAt: z.coerce.date(),
  }),
});

export const customerEvents = [customerRegisteredV1];
