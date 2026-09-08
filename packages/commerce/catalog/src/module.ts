import packageJson from '../package.json';
import { defineModule } from '@storeweave/kernel';
import { catalogMigrations } from './migrations';
import { catalogEvents } from './events';
import { createProductCommand, createProductHandler, updateProductCommand, updateProductHandler } from './commands';
import { getProductHandler, getProductQuery, searchProductsHandler, searchProductsQuery } from './queries';

export const catalogModule = defineModule({
  name: 'catalog',
  version: packageJson.version,
  baseVersionRange: '^1.0.0',
  dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }] },
  data: { owns: ['catalog_products'] },
  migrations: catalogMigrations,
  events: catalogEvents,
  permissions: [
    { key: 'catalog:read', description: '讀取商品資料', owner: 'catalog' },
    { key: 'catalog:write', description: '建立與修改商品', owner: 'catalog' },
  ],
  commands: [
    { descriptor: createProductCommand, handler: createProductHandler },
    { descriptor: updateProductCommand, handler: updateProductHandler },
  ],
  queries: [
    { descriptor: getProductQuery, handler: getProductHandler },
    { descriptor: searchProductsQuery, handler: searchProductsHandler },
  ],
});
