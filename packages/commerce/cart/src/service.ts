import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { catalogService } from '@storeweave/catalog';
import { inventoryService } from '@storeweave/inventory';
import type { CartDto } from './dto';
import { CartRepository } from './repository';
import type { CartRow } from './schema';

const repository = new CartRepository();

/**
 * 把購物車讀成 DTO。價格與可售量都是**當下**查出來的：購物車不凍結價格，
 * 顧客看到的永遠是現在的金額，結帳時才不會突然變動。
 */
export async function toCartDto(
  db: DrizzleDb | Tx,
  cart: CartRow,
  defaultCurrency: string,
): Promise<CartDto> {
  const rows = await repository.items(db, cart.id);
  const items = [];

  for (const row of rows) {
    const product = await catalogService.findById(db, row.productId);
    // 下架或刪除的商品不在購物車裡顯示；合併與結帳各自處理它們（工單 27、28）。
    if (!product || product.status !== 'active') continue;

    const available = await inventoryService.availableFor(db, row.productId).catch(() => null);
    items.push({
      productId: product.id,
      sku: product.sku,
      name: product.name,
      unitPriceCents: product.priceCents,
      quantity: row.quantity,
      lineTotalCents: product.priceCents * row.quantity,
      available,
    });
  }

  return {
    id: cart.id,
    currency: items.length > 0 ? defaultCurrency : defaultCurrency,
    items,
    subtotalCents: items.reduce((sum, i) => sum + i.lineTotalCents, 0),
  };
}
