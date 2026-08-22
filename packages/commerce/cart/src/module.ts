import { defineModule } from '@storeweave/kernel';
import { createCartModule, type CartModuleDeps } from './commands';
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
    queries: createCartQueries(deps).queries,
  });
}
