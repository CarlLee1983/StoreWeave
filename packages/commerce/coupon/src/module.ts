import packageJson from '../package.json';
import { z } from 'zod';
import { defineModule, type PlatformModule } from '@storeweave/kernel';
import { defineEvent } from '@storeweave/contracts';
import { customerRegisteredV1 } from '@storeweave/customer';
import {
  createCouponCommand, createCouponHandler, createIssueAutoCouponsHandler, createIssueBirthdayCouponsHandler,
  issueAutoCouponsCommand, issueBirthdayCouponsCommand, issueCouponsCommand, issueCouponsHandler,
  setCouponStatusCommand, setCouponStatusHandler, type CouponModuleDeps,
} from './commands';
import { BIRTHDAY_COUPONS_JOB, createBirthdayCouponsJob } from './jobs';
import { couponMigrations } from './migrations';
import {
  attributionSummaryQuery, createAttributionSummaryHandler,
  createPromotionPerformanceHandler, promotionPerformanceQuery,
  getCouponHandler, getCouponQuery, listCouponsHandler, listCouponsQuery,
  createListMyCouponsHandler, listMyCouponsQuery,
} from './queries';

export function createCouponModule(deps: CouponModuleDeps): PlatformModule {
  return defineModule({
  name: 'coupon',
  version: packageJson.version,
  baseVersionRange: '^1.0.0',
  dependencies: { required: [
    { name: 'platform', versionRange: '^0.1.0' },
    { name: 'customer', versionRange: '^0.1.0' },
    { name: 'promotion', versionRange: '^0.1.0' },
  ] },
  data: { owns: ['coupon_coupons', 'coupon_redemptions'] },
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
    { descriptor: issueBirthdayCouponsCommand, handler: createIssueBirthdayCouponsHandler(deps) },
  ],
  jobs: [
    {
      type: BIRTHDAY_COUPONS_JOB,
      handler: createBirthdayCouponsJob(),
      jobContractV1: { currentVersion: 1, versions: { 1: z.object({ bucket: z.number().int(), scheduledFor: z.string().datetime() }).strict() } },
      // 一天一次。切片對齊 UTC，因此它在店鋪時區的哪個時刻跑不固定——
      // handler 自己以店鋪時區判斷「今天」，所以這不影響正確性。
      schedule: { everyMs: 24 * 60 * 60 * 1000 },
    },
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
    { descriptor: attributionSummaryQuery, handler: createAttributionSummaryHandler(deps) },
    { descriptor: promotionPerformanceQuery, handler: createPromotionPerformanceHandler(deps) },
    { descriptor: listMyCouponsQuery, handler: createListMyCouponsHandler(deps) },
  ],
  });
}
