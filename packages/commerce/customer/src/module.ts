import { defineModule } from '@storeweave/kernel';
import { registerCustomerCommand, registerCustomerHandler } from './commands';
import { customerMigrations } from './migrations';

export const customerModule = defineModule({
  name: 'customer',
  migrations: customerMigrations,
  permissions: [
    { key: 'customer:register', description: '註冊成為會員', owner: 'customer' },
    { key: 'customer:read', description: '讀取顧客資料', owner: 'customer' },
    { key: 'customer:write', description: '修改顧客資料', owner: 'customer' },
  ],
  commands: [
    { descriptor: registerCustomerCommand, handler: registerCustomerHandler },
  ],
  queries: [],
});
