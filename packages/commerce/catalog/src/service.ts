import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { PlatformError } from '@storeweave/contracts';
import { ProductRepository, toProductDto } from './repository';
import type { ProductDto } from './dto';

const repository = new ProductRepository();

/**
 * Catalog 對其他 Core 模組公開的介面。
 * 其他模組（例如 order）只能走這裡，不得直接查 catalog_products。
 */
export const catalogService = {
  async requireActiveProduct(db: DrizzleDb | Tx, productId: string): Promise<ProductDto> {
    const row = await repository.findById(db, productId);
    if (!row) throw PlatformError.notFound('Product', productId);
    if (row.status !== 'active') {
      throw PlatformError.conflict(`Product ${row.sku} is not purchasable (status=${row.status})`);
    }
    return toProductDto(row);
  },

  async findById(db: DrizzleDb | Tx, productId: string): Promise<ProductDto | null> {
    const row = await repository.findById(db, productId);
    return row ? toProductDto(row) : null;
  },
};
