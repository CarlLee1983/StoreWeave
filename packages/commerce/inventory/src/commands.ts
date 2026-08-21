import type { z } from 'zod';
import { defineCommand, type CommandContext } from '@storeweave/contracts';
import { adjustStockInput, stockDto } from './dto';
import { inventoryService } from './service';

export const adjustStockCommand = defineCommand({
  name: 'commerce.inventory.adjustStock',
  summary: '調整庫存',
  input: adjustStockInput,
  output: stockDto,
  permission: 'inventory:write',
  /** 庫存異動是非冪等操作，必須帶 Idempotency Key 才能安全重試。 */
  idempotency: 'required',
  audit: {
    action: 'inventory.stock.adjusted',
    resourceType: 'product',
    resourceId: (i) => i.productId,
    redact: (i) => ({ delta: i.delta, reason: i.reason, reference: i.reference }),
  },
});

export const adjustStockHandler = async (
  input: z.infer<typeof adjustStockInput>,
  ctx: CommandContext,
) => inventoryService.adjust(ctx, input);
