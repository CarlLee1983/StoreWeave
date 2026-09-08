import packageJson from '../package.json';
import { defineModule } from '@storeweave/kernel';
import { inventoryMigrations } from './migrations';
import { inventoryEvents } from './events';
import { adjustStockCommand, adjustStockHandler } from './commands';
import { getStockHandler, getStockQuery, listStockHandler, listStockQuery } from './queries';

export const inventoryModule = defineModule({
  name: 'inventory',
  version: packageJson.version,
  baseVersionRange: '^1.0.0',
  dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }] },
  data: { owns: ['inventory_stock', 'inventory_movements'] },
  migrations: inventoryMigrations,
  events: inventoryEvents,
  permissions: [
    { key: 'inventory:read', description: '讀取庫存', owner: 'inventory' },
    { key: 'inventory:write', description: '調整庫存', owner: 'inventory' },
  ],
  commands: [{ descriptor: adjustStockCommand, handler: adjustStockHandler }],
  queries: [
    { descriptor: getStockQuery, handler: getStockHandler },
    { descriptor: listStockQuery, handler: listStockHandler },
  ],
});
