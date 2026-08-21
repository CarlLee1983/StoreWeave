import { defineModule } from '@storeweave/kernel';
import {
  createPromotionCommand,
  createPromotionHandler,
  setPromotionStatusCommand,
  setPromotionStatusHandler,
  updatePromotionCommand,
  updatePromotionHandler,
} from './commands';
import { promotionMigrations } from './migrations';
import { getPromotionHandler, getPromotionQuery, listPromotionsHandler, listPromotionsQuery, quoteHandler, quoteQuery } from './queries';

export const promotionModule = defineModule({
  name: 'promotion',
  migrations: promotionMigrations,
  permissions: [
    { key: 'promotion:read', description: '讀取促銷活動', owner: 'promotion' },
    { key: 'promotion:write', description: '建立、編輯與停用促銷活動', owner: 'promotion' },
    { key: 'promotion:quote', description: '結帳前試算', owner: 'promotion' },
  ],
  commands: [
    { descriptor: createPromotionCommand, handler: createPromotionHandler },
    { descriptor: updatePromotionCommand, handler: updatePromotionHandler },
    { descriptor: setPromotionStatusCommand, handler: setPromotionStatusHandler },
  ],
  queries: [
    { descriptor: getPromotionQuery, handler: getPromotionHandler },
    { descriptor: listPromotionsQuery, handler: listPromotionsHandler },
    { descriptor: quoteQuery, handler: quoteHandler },
  ],
});
