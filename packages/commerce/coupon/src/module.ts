import { defineModule, type PlatformModule } from '@storeweave/kernel';
import { defineEvent } from '@storeweave/contracts';
import { customerRegisteredV1 } from '@storeweave/customer';
import {
  createCouponCommand, createCouponHandler, createIssueAutoCouponsHandler, issueAutoCouponsCommand,
  issueCouponsCommand, issueCouponsHandler, setCouponStatusCommand, setCouponStatusHandler,
  type CouponModuleDeps,
} from './commands';
import { couponMigrations } from './migrations';
import { getCouponHandler, getCouponQuery, listCouponsHandler, listCouponsQuery } from './queries';

export function createCouponModule(deps: CouponModuleDeps): PlatformModule {
  return defineModule({
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
    { descriptor: issueAutoCouponsCommand, handler: createIssueAutoCouponsHandler(deps) },
  ],
  /**
   * 新會員一註冊就發券。投遞經過 Outbox 與背景工作，因此發券失敗不會讓註冊
   * 跟著回滾；重複投遞由發放的去重鍵擋下。
   */
  subscribers: [
    {
      eventName: customerRegisteredV1.name,
      handler: async (event, ctx) => {
        const { customerId } = event.payload as { customerId: string };
        await ctx.executeCommand?.(
          'commerce.coupon.issueAutoCoupons',
          { trigger: 'signup', customerId, occurrence: 'signup' },
          `coupon-signup:${customerId}`,
        );
      },
    },
  ],
  queries: [
    { descriptor: getCouponQuery, handler: getCouponHandler },
    { descriptor: listCouponsQuery, handler: listCouponsHandler },
  ],
  });
}
