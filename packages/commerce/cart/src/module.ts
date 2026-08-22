import { defineModule } from '@storeweave/kernel';
import { createCartModule, type CartModuleDeps } from './commands';
import { PURGE_STALE_GUEST_CARTS_JOB, createPurgeStaleGuestCartsJob } from './jobs';
import { cartMigrations } from './migrations';
import { createCartQueries } from './queries';

export function createCart(deps: CartModuleDeps) {
  return defineModule({
    name: 'cart',
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
