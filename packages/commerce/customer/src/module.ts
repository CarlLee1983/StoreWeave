import { defineModule } from '@storeweave/kernel';
import {
  registerCustomerCommand,
  registerCustomerHandler,
  setCustomerBirthdayCommand,
  setCustomerBirthdayHandler,
  updateMyProfileCommand,
  updateMyProfileHandler,
} from './commands';
import { getMyProfileHandler, getMyProfileQuery } from './queries';
import { customerMigrations } from './migrations';

export const customerModule = defineModule({
  name: 'customer',
  migrations: customerMigrations,
  permissions: [
    { key: 'customer:register', description: '註冊成為會員', owner: 'customer' },
    { key: 'customer:read', description: '讀取顧客資料', owner: 'customer' },
    { key: 'customer:write', description: '修改顧客資料', owner: 'customer' },
    { key: 'customers:manage', description: '後台管理會員（含代為修正生日）', owner: 'customer' },
  ],
  commands: [
    { descriptor: registerCustomerCommand, handler: registerCustomerHandler },
    { descriptor: updateMyProfileCommand, handler: updateMyProfileHandler },
    { descriptor: setCustomerBirthdayCommand, handler: setCustomerBirthdayHandler },
  ],
  queries: [
    { descriptor: getMyProfileQuery, handler: getMyProfileHandler },
  ],
});
