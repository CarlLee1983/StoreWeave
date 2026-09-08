import packageJson from '../package.json';
import { defineModule } from '@storeweave/kernel';
import { createCartModule, type CartModuleDeps } from './commands';
import { PURGE_STALE_GUEST_CARTS_JOB, createPurgeStaleGuestCartsJob } from './jobs';
import { cartMigrations } from './migrations';
import { createCartQueries } from './queries';

export function createCart(deps: CartModuleDeps) {
  return defineModule({
    name: 'cart',
  version: packageJson.version,
  baseVersionRange: '^1.0.0',
  dependencies: { required: [
    { name: 'platform', versionRange: '^0.1.0' },
    { name: 'catalog', versionRange: '^0.1.0' },
    { name: 'coupon', versionRange: '^0.1.0' },
    { name: 'customer', versionRange: '^0.1.0' },
    { name: 'inventory', versionRange: '^0.1.0' },
    { name: 'loyalty', versionRange: '^0.1.0' },
    { name: 'promotion', versionRange: '^0.1.0' },
  ] },
  data: { owns: ['cart_carts', 'cart_items'] },
    migrations: cartMigrations,
    permissions: [
      { key: 'cart:read', description: '讀取購物車', owner: 'cart' },
      { key: 'cart:write', description: '修改購物車', owner: 'cart' },
    ],
    commands: createCartModule(deps).commands,
    jobs: [
      {
        type: PURGE_STALE_GUEST_CARTS_JOB,
        handler: createPurgeStaleGuestCartsJob(),
        // 一天一次就夠：保留期是三十天，清理晚幾小時不會有人察覺。
        schedule: { everyMs: 24 * 60 * 60 * 1000 },
      },
    ],
    queries: createCartQueries(deps).queries,
  });
}
