import packageJson from '../package.json';
import { z } from 'zod';
import { defineModule, type PlatformModule } from '@storeweave/kernel';
import {
  adjustRewardsCommand, adjustRewardsHandler,
  createNotifyExpiringRewardsHandler, notifyExpiringRewardsCommand,
  adjustTierPointsCommand, adjustTierPointsHandler,
  recalculateTiersCommand, recalculateTiersHandler,
  removeTierCommand, removeTierHandler,
  saveTierCommand, saveTierHandler,
  updateRewardSettingsCommand, updateRewardSettingsHandler,
  type LoyaltyModuleDeps,
} from './commands';
import {
  NOTIFY_EXPIRING_REWARDS_JOB, RECALCULATE_TIERS_JOB,
  createNotifyExpiringRewardsJob, createRecalculateTiersJob,
} from './jobs';
import { loyaltyMigrations } from './migrations';
import {
  createGetCustomerLoyaltyHandler, getCustomerLoyaltyQuery,
  getMyRewardsHandler, getMyRewardsQuery,
  getMyTierHandler, getMyTierQuery,
  listTiersHandler, listTiersQuery,
  getRewardSettingsHandler, getRewardSettingsQuery,
  createOutstandingRewardsHandler, outstandingRewardsQuery,
} from './queries';

export function createLoyaltyModule(deps: LoyaltyModuleDeps): PlatformModule {
  return defineModule({
  name: 'loyalty',
  version: packageJson.version,
  baseVersionRange: '^1.0.0',
  dependencies: { required: [
    { name: 'platform', versionRange: '^0.1.0' },
    { name: 'customer', versionRange: '^0.1.0' },
  ] },
  data: { owns: ['loyalty_reward_entries', 'loyalty_settings', 'loyalty_tier_entries', 'loyalty_tiers', 'loyalty_customer_tiers', 'loyalty_reward_expiry_notices'] },
  migrations: loyaltyMigrations,
  // 等級門檻與購物金累積比例原本借用 promotion:write。改成自己的鍵：
  // 改累積比例會直接改動購物金這本負債帳，那與編一檔活動不是同一種授權。
  permissions: [{ key: 'loyalty:write', description: '維護會員等級與購物金累積規則', owner: 'loyalty' }],
  commands: [
    { descriptor: updateRewardSettingsCommand, handler: updateRewardSettingsHandler },
    { descriptor: adjustRewardsCommand, handler: adjustRewardsHandler },
    { descriptor: saveTierCommand, handler: saveTierHandler },
    { descriptor: removeTierCommand, handler: removeTierHandler },
    { descriptor: adjustTierPointsCommand, handler: adjustTierPointsHandler },
    { descriptor: recalculateTiersCommand, handler: recalculateTiersHandler },
    { descriptor: notifyExpiringRewardsCommand, handler: createNotifyExpiringRewardsHandler(deps) },
  ],
  jobs: [
    {
      type: RECALCULATE_TIERS_JOB,
      handler: createRecalculateTiersJob(),
      jobContractV1: { currentVersion: 1, versions: { 1: z.object({ bucket: z.number().int(), scheduledFor: z.string().datetime() }).strict() } },
      // 一天一次。等級是帳本的推導值，快取晚幾小時更新不影響正確性。
      schedule: { everyMs: 24 * 60 * 60 * 1000 },
    },
    {
      type: NOTIFY_EXPIRING_REWARDS_JOB,
      handler: createNotifyExpiringRewardsJob(),
      jobContractV1: { currentVersion: 1, versions: { 1: z.object({ bucket: z.number().int(), scheduledFor: z.string().datetime() }).strict() } },
      schedule: { everyMs: 24 * 60 * 60 * 1000 },
    },
  ],
  queries: [
    { descriptor: getMyRewardsQuery, handler: getMyRewardsHandler },
    { descriptor: getRewardSettingsQuery, handler: getRewardSettingsHandler },
    { descriptor: outstandingRewardsQuery, handler: createOutstandingRewardsHandler(deps) },
    { descriptor: getMyTierQuery, handler: getMyTierHandler },
    { descriptor: listTiersQuery, handler: listTiersHandler },
    { descriptor: getCustomerLoyaltyQuery, handler: createGetCustomerLoyaltyHandler(deps) },
  ],
  });
}
