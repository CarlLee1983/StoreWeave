import { PlatformError, type CommandContext } from '@storeweave/contracts';
import { StockRepository, toStockDto } from './repository';
import { inventoryAdjustedV1 } from './events';
import type { StockDto } from './dto';

const repository = new StockRepository();

/**
 * Inventory 對其他 Core 模組公開的介面。
 * order 模組扣庫存只能走這裡，不得直接寫 inventory_stock。
 */
export const inventoryService = {
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
    if (next < 0) {
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
