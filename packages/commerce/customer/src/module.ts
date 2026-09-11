import packageJson from '../package.json';
import { defineModule } from '@storeweave/kernel';
import {
  registerCustomerCommand,
  registerCustomerHandler,
  setCustomerBirthdayCommand,
  setCustomerBirthdayHandler,
  setCustomerStatusCommand,
  setCustomerStatusHandler,
  updateMyProfileCommand,
  updateMyProfileHandler,
} from './commands';
import { getCustomerHandler, getCustomerQuery, getMyProfileHandler, getMyProfileQuery, listCustomersHandler, listCustomersQuery } from './queries';
import { customerEvents } from './events';
import { customerMigrations } from './migrations';
import { customerPages } from './pages';

export const customerModule = defineModule({
  name: 'customer',
  version: packageJson.version,
  baseVersionRange: '^1.0.0',
  dependencies: { required: [
    { name: 'platform', versionRange: '^0.1.0' },
    { name: 'platform-identity', versionRange: '^0.1.0' },
  ] },
  capabilities: { provides: ['commerce.customer.contact-link'] },
  data: { owns: ['customer_customers'] },
  migrations: customerMigrations,
  events: customerEvents,
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
    { descriptor: setCustomerStatusCommand, handler: setCustomerStatusHandler },
  ],
  queries: [
    { descriptor: getMyProfileQuery, handler: getMyProfileHandler },
    { descriptor: listCustomersQuery, handler: listCustomersHandler },
    { descriptor: getCustomerQuery, handler: getCustomerHandler },
  ],
  pages: customerPages,
});
