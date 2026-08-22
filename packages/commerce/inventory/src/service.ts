import { PlatformError, type CommandContext, type DrizzleDb, type Tx } from '@storeweave/contracts';
import { StockRepository, toStockDto } from './repository';
import { inventoryAdjustedV1 } from './events';
import type { StockDto } from './dto';

const repository = new StockRepository();

/**
 * Inventory 對其他 Core 模組公開的介面。
 * order 模組扣庫存只能走這裡，不得直接寫 inventory_stock。
 */
export const inventoryService = {
  /** 唯讀的可售量。購物車與試算要顯示它，但兩者都不預留。 */
  async availableFor(db: DrizzleDb | Tx, productId: string): Promise<number | null> {
    const row = await repository.find(db, productId);
    return row ? row.onHand - row.reserved : null;
  },

  /** 預留不改變實體庫存；可售量永遠是 onHand - reserved。 */
  async reserve(ctx: CommandContext, input: { productId: string; quantity: number; reference?: string | null }): Promise<StockDto> {
    const current = await repository.lockOrCreate(ctx.tx, input.productId);
    if (current.onHand - current.reserved < input.quantity) {
      throw PlatformError.conflict(`Insufficient available stock for product ${input.productId}`);
    }
    const updated = await repository.applyReservation(ctx.tx, input.productId, input.quantity);
    await repository.recordMovement(ctx.tx, { productId: input.productId, delta: 0, reason: 'reserved', reference: input.reference ?? null, actorId: ctx.actor.id });
    return toStockDto(updated);
  },

  async release(ctx: CommandContext, input: { productId: string; quantity: number; reference?: string | null }): Promise<StockDto> {
    const current = await repository.lockOrCreate(ctx.tx, input.productId);
    if (current.reserved < input.quantity) throw PlatformError.conflict(`Reservation missing for product ${input.productId}`);
    const updated = await repository.applyReservation(ctx.tx, input.productId, -input.quantity);
    await repository.recordMovement(ctx.tx, { productId: input.productId, delta: 0, reason: 'reservation-released', reference: input.reference ?? null, actorId: ctx.actor.id });
    return toStockDto(updated);
  },

  /** 將既有預留轉為實體出庫；兩數同時降低，available 不變。 */
  async commitReservation(ctx: CommandContext, input: { productId: string; quantity: number; reference?: string | null }): Promise<StockDto> {
    const current = await repository.lockOrCreate(ctx.tx, input.productId);
    if (current.reserved < input.quantity || current.onHand < input.quantity) throw PlatformError.conflict(`Reservation missing for product ${input.productId}`);
    const updated = await repository.applyDelta(ctx.tx, input.productId, -input.quantity);
    const committed = await repository.applyReservation(ctx.tx, input.productId, -input.quantity);
    await repository.recordMovement(ctx.tx, { productId: input.productId, delta: -input.quantity, reason: 'reservation-committed', reference: input.reference ?? null, actorId: ctx.actor.id });
    return toStockDto({ ...committed, updatedAt: updated.updatedAt });
  },
  /**
   * 套用庫存異動並發布版本化事件。
   * 扣減會先鎖列再檢查，庫存不足時拋 CONFLICT，整個交易回滾。
   */
  async adjust(
    ctx: CommandContext,
    input: { productId: string; delta: number; reason: string; reference?: string | null },
  ): Promise<StockDto> {
    const current = await repository.lockOrCreate(ctx.tx, input.productId);
    const next = current.onHand + input.delta;
    if (next < 0 || next < current.reserved) {
      throw PlatformError.conflict(
        `Insufficient stock for product ${input.productId}: on hand ${current.onHand}, requested ${input.delta}`,
      );
    }
    const updated = await repository.applyDelta(ctx.tx, input.productId, input.delta);
    await repository.recordMovement(ctx.tx, {
      productId: input.productId,
      delta: input.delta,
      reason: input.reason,
      reference: input.reference ?? null,
      actorId: ctx.actor.id,
    });
    await ctx.publish({
      name: inventoryAdjustedV1.name,
      payload: {
        productId: input.productId,
        delta: input.delta,
        onHand: updated.onHand,
        reason: input.reason,
        reference: input.reference ?? null,
      },
    });
    return toStockDto(updated);
  },

  async snapshot(ctx: { tx: any }, productId: string) {
    return repository.find(ctx.tx, productId);
  },
};
