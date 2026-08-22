import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineQuery, type QueryContext } from '@storeweave/contracts';
import { cartDto, getCartInput } from './dto';
import { CartRepository, resolveOwner } from './repository';
import { toCartDto } from './service';

const repository = new CartRepository();

export function createCartQueries(deps: { defaultCurrency: string }) {
  const getCartQuery = defineQuery({
    name: 'commerce.cart.getCart',
    summary: '讀取目前的購物車',
    input: getCartInput,
    output: cartDto,
    permission: 'cart:read',
  });

  /** 還沒有購物車就回一台空的——讀取不該有副作用，也不該讓前台先處理 404。 */
  const getCartHandler = async (input: z.infer<typeof getCartInput>, ctx: QueryContext) => {
    const owner = await resolveOwner(ctx.db, ctx.actor, input.guestToken);
    const cart = await repository.find(ctx.db, owner);
    if (!cart) {
      return { id: randomUUID(), currency: deps.defaultCurrency, items: [], subtotalCents: 0 };
    }
    return toCartDto(ctx.db, cart, deps.defaultCurrency);
  };

  return { queries: [{ descriptor: getCartQuery, handler: getCartHandler }] };
}
