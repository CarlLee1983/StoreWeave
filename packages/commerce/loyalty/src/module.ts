import { defineModule, type PlatformModule } from '@storeweave/kernel';
import {
  adjustRewardsCommand, adjustRewardsHandler,
  adjustTierPointsCommand, adjustTierPointsHandler,
  recalculateTiersCommand, recalculateTiersHandler,
  removeTierCommand, removeTierHandler,
  saveTierCommand, saveTierHandler,
  updateRewardSettingsCommand, updateRewardSettingsHandler,
} from './commands';
import { RECALCULATE_TIERS_JOB, createRecalculateTiersJob } from './jobs';
import { loyaltyMigrations } from './migrations';
import {
  getMyRewardsHandler, getMyRewardsQuery,
  getMyTierHandler, getMyTierQuery,
  listTiersHandler, listTiersQuery,
  getRewardSettingsHandler, getRewardSettingsQuery,
  outstandingRewardsHandler, outstandingRewardsQuery,
} from './queries';

export const loyaltyModule: PlatformModule = defineModule({
  name: 'loyalty',
  migrations: loyaltyMigrations,
  commands: [
    { descriptor: updateRewardSettingsCommand, handler: updateRewardSettingsHandler },
    { descriptor: adjustRewardsCommand, handler: adjustRewardsHandler },
    { descriptor: saveTierCommand, handler: saveTierHandler },
    { descriptor: removeTierCommand, handler: removeTierHandler },
    { descriptor: adjustTierPointsCommand, handler: adjustTierPointsHandler },
    { descriptor: recalculateTiersCommand, handler: recalculateTiersHandler },
  ],
  jobs: [
    {
      type: RECALCULATE_TIERS_JOB,
      handler: createRecalculateTiersJob(),
      // 一天一次。等級是帳本的推導值，快取晚幾小時更新不影響正確性。
      schedule: { everyMs: 24 * 60 * 60 * 1000 },
    },
  ],
  queries: [
    { descriptor: getMyRewardsQuery, handler: getMyRewardsHandler },
    { descriptor: getRewardSettingsQuery, handler: getRewardSettingsHandler },
    { descriptor: outstandingRewardsQuery, handler: outstandingRewardsHandler },
    { descriptor: getMyTierQuery, handler: getMyTierHandler },
    { descriptor: listTiersQuery, handler: listTiersHandler },
  ],
});
