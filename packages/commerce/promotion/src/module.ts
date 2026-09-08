import packageJson from '../package.json';
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
import { createQuoteHandler, getPromotionHandler, getPromotionQuery, listPromotionsHandler, listPromotionsQuery, quoteQuery } from './queries';

export interface PromotionModuleDeps {
  /** 試算的幣別判斷要與下單相同，因此和 order 模組吃同一個設定值。 */
  defaultCurrency: string;
}

export function createPromotionModule(deps: PromotionModuleDeps) {
  return defineModule({
  name: 'promotion',
  version: packageJson.version,
  baseVersionRange: '^1.0.0',
  dependencies: { required: [
    { name: 'platform', versionRange: '^0.1.0' },
    { name: 'catalog', versionRange: '^0.1.0' },
  ] },
  data: { owns: ['promotion_promotions'] },
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
    { descriptor: quoteQuery, handler: createQuoteHandler(deps) },
  ],
  });
}
