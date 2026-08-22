import { defineModule, type PlatformModule } from '@storeweave/kernel';
import {
  adjustRewardsCommand, adjustRewardsHandler,
  updateRewardSettingsCommand, updateRewardSettingsHandler,
} from './commands';
import { loyaltyMigrations } from './migrations';
import {
  getMyRewardsHandler, getMyRewardsQuery,
  getRewardSettingsHandler, getRewardSettingsQuery,
  outstandingRewardsHandler, outstandingRewardsQuery,
} from './queries';

export const loyaltyModule: PlatformModule = defineModule({
  name: 'loyalty',
  migrations: loyaltyMigrations,
  commands: [
    { descriptor: updateRewardSettingsCommand, handler: updateRewardSettingsHandler },
    { descriptor: adjustRewardsCommand, handler: adjustRewardsHandler },
  ],
  queries: [
    { descriptor: getMyRewardsQuery, handler: getMyRewardsHandler },
    { descriptor: getRewardSettingsQuery, handler: getRewardSettingsHandler },
    { descriptor: outstandingRewardsQuery, handler: outstandingRewardsHandler },
  ],
});
