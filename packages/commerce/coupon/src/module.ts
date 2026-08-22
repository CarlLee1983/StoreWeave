import { defineModule, type PlatformModule } from '@storeweave/kernel';
import {
  createCouponCommand, createCouponHandler, issueCouponsCommand, issueCouponsHandler,
  setCouponStatusCommand, setCouponStatusHandler,
} from './commands';
import { couponMigrations } from './migrations';
import { getCouponHandler, getCouponQuery, listCouponsHandler, listCouponsQuery } from './queries';

export const couponModule: PlatformModule = defineModule({
  name: 'coupon',
  migrations: couponMigrations,
  permissions: [
    { key: 'coupon:read', description: '讀取券', owner: 'coupon' },
    { key: 'coupon:write', description: '建立與停用券', owner: 'coupon' },
  ],
  commands: [
    { descriptor: createCouponCommand, handler: createCouponHandler },
    { descriptor: setCouponStatusCommand, handler: setCouponStatusHandler },
    { descriptor: issueCouponsCommand, handler: issueCouponsHandler },
  ],
  queries: [
    { descriptor: getCouponQuery, handler: getCouponHandler },
    { descriptor: listCouponsQuery, handler: listCouponsHandler },
  ],
});
