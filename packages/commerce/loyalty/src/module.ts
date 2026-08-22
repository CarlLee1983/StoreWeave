import { defineModule, type PlatformModule } from '@storeweave/kernel';
import {
  adjustRewardsCommand, adjustRewardsHandler,
  adjustTierPointsCommand, adjustTierPointsHandler,
  recalculateTiersCommand, recalculateTiersHandler,
  removeTierCommand, removeTierHandler,
  saveTierCommand, saveTierHandler,
  updateRewardSettingsCommand, updateRewardSettingsHandler,
} from './commands';
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
  queries: [
    { descriptor: getMyRewardsQuery, handler: getMyRewardsHandler },
    { descriptor: getRewardSettingsQuery, handler: getRewardSettingsHandler },
    { descriptor: outstandingRewardsQuery, handler: outstandingRewardsHandler },
    { descriptor: getMyTierQuery, handler: getMyTierHandler },
    { descriptor: listTiersQuery, handler: listTiersHandler },
  ],
});
