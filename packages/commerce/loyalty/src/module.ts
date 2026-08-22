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
  getCustomerLoyaltyHandler, getCustomerLoyaltyQuery,
  getMyRewardsHandler, getMyRewardsQuery,
  getMyTierHandler, getMyTierQuery,
  listTiersHandler, listTiersQuery,
  getRewardSettingsHandler, getRewardSettingsQuery,
  outstandingRewardsHandler, outstandingRewardsQuery,
} from './queries';

export function createLoyaltyModule(deps: LoyaltyModuleDeps): PlatformModule {
  return defineModule({
  name: 'loyalty',
  migrations: loyaltyMigrations,
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
      // 一天一次。等級是帳本的推導值，快取晚幾小時更新不影響正確性。
      schedule: { everyMs: 24 * 60 * 60 * 1000 },
    },
    {
      type: NOTIFY_EXPIRING_REWARDS_JOB,
      handler: createNotifyExpiringRewardsJob(),
      schedule: { everyMs: 24 * 60 * 60 * 1000 },
    },
  ],
  queries: [
    { descriptor: getMyRewardsQuery, handler: getMyRewardsHandler },
    { descriptor: getRewardSettingsQuery, handler: getRewardSettingsHandler },
    { descriptor: outstandingRewardsQuery, handler: outstandingRewardsHandler },
    { descriptor: getMyTierQuery, handler: getMyTierHandler },
    { descriptor: listTiersQuery, handler: listTiersHandler },
    { descriptor: getCustomerLoyaltyQuery, handler: getCustomerLoyaltyHandler },
  ],
  });
}
