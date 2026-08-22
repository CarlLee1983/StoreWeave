import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineQuery, type QueryContext } from '@storeweave/contracts';
import { cartDto, getCartInput } from './dto';
import { CartRepository, resolveOwner } from './repository';
import { emptyCartDto, toCartDto } from './service';

const repository = new CartRepository();

export function createCartQueries(deps: { defaultCurrency: string }) {
  const getCartQuery = defineQuery({
    name: 'commerce.cart.getCart',
    summary: '讀取目前的購物車',
    input: getCartInput,
    output: cartDto,
    permission: 'cart:read',
  });

  /**
   * 還沒有購物車就回一台空的——讀取不該有副作用，也不該讓前台先處理 404。
   *
   * 連識別都沒有（訪客沒帶 token）同樣回空車，而不是錯誤：讀取沒有東西可以做錯，
   * 而丟錯會逼呼叫端在讀取路徑上先簽發一張 token——那正是「讀一次就換一台車」的來源。
   */
  const getCartHandler = async (input: z.infer<typeof getCartInput>, ctx: QueryContext) => {
    if (ctx.actor.type !== 'customer' && !input.guestToken) {
      return emptyCartDto(randomUUID(), deps.defaultCurrency);
    }
    const owner = await resolveOwner(ctx.db, ctx.actor, input.guestToken);
    const cart = await repository.find(ctx.db, owner);
    if (!cart) {
      return emptyCartDto(randomUUID(), deps.defaultCurrency);
    }
    return toCartDto(ctx.db, cart, deps.defaultCurrency, ctx.now, ctx.logger);
  };

  return { queries: [{ descriptor: getCartQuery, handler: getCartHandler }] };
}
