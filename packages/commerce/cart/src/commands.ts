import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import { catalogService } from '@storeweave/catalog';
import {
  addToCartInput,
  cartDto,
  clearCartInput,
  removeCartItemInput,
  setCartItemQuantityInput,
  type CartDto,
} from './dto';
import { CartRepository, resolveOwner } from './repository';
import { toCartDto } from './service';

const repository = new CartRepository();

export interface CartModuleDeps {
  defaultCurrency: string;
}

/** 加入購物車前確認商品真的買得到——下架的商品不該先進車再在結帳時才失敗。 */
async function requirePurchasable(ctx: CommandContext, productId: string): Promise<void> {
  await catalogService.requireActiveProduct(ctx.tx, productId);
}

async function openCart(ctx: CommandContext, guestToken: string | undefined) {
  const owner = await resolveOwner(ctx.tx, ctx.actor, guestToken);
  return repository.findOrCreate(ctx.tx, owner, ctx.now);
}

function cartCommand(name: string, summary: string, input: z.ZodTypeAny, action: string) {
  return defineCommand({
    name,
    summary,
    input,
    output: cartDto,
    permission: 'cart:write',
    idempotency: 'optional',
    audit: {
      action,
      resourceType: 'cart',
      resourceId: (_i, o: CartDto) => o.id,
      // 購物車內容不是稽核要的東西，而 guestToken 是識別碼，兩者都不進紀錄。
      redact: () => ({}),
    },
  });
}

export function createCartModule(deps: CartModuleDeps) {
  const addToCartCommand = cartCommand('commerce.cart.addToCart', '加入購物車', addToCartInput, 'cart.item-added');
  const setCartItemQuantityCommand = cartCommand(
    'commerce.cart.setCartItemQuantity', '調整購物車數量', setCartItemQuantityInput, 'cart.item-quantity-set',
  );
  const removeCartItemCommand = cartCommand('commerce.cart.removeCartItem', '從購物車移除', removeCartItemInput, 'cart.item-removed');
  const clearCartCommand = cartCommand('commerce.cart.clearCart', '清空購物車', clearCartInput, 'cart.cleared');

  const addToCartHandler = async (input: z.infer<typeof addToCartInput>, ctx: CommandContext): Promise<CartDto> => {
    await requirePurchasable(ctx, input.productId);
    const cart = await openCart(ctx, input.guestToken);
    // 再加一次同一件商品是累加：使用者的意圖是「再來一個」，不是「覆蓋成一個」。
    await repository.addQuantity(ctx.tx, cart.id, input.productId, input.quantity, ctx.now);
    await repository.touch(ctx.tx, cart.id, ctx.now);
    return toCartDto(ctx.tx, cart, deps.defaultCurrency);
  };

  const setCartItemQuantityHandler = async (
    input: z.infer<typeof setCartItemQuantityInput>,
    ctx: CommandContext,
  ): Promise<CartDto> => {
    const cart = await openCart(ctx, input.guestToken);
    if (input.quantity === 0) {
      await repository.removeItem(ctx.tx, cart.id, input.productId);
    } else {
      await requirePurchasable(ctx, input.productId);
      await repository.setQuantity(ctx.tx, cart.id, input.productId, input.quantity, ctx.now);
    }
    await repository.touch(ctx.tx, cart.id, ctx.now);
    return toCartDto(ctx.tx, cart, deps.defaultCurrency);
  };

  const removeCartItemHandler = async (
    input: z.infer<typeof removeCartItemInput>,
    ctx: CommandContext,
  ): Promise<CartDto> => {
    const cart = await openCart(ctx, input.guestToken);
    await repository.removeItem(ctx.tx, cart.id, input.productId);
    await repository.touch(ctx.tx, cart.id, ctx.now);
    return toCartDto(ctx.tx, cart, deps.defaultCurrency);
  };

  const clearCartHandler = async (input: z.infer<typeof clearCartInput>, ctx: CommandContext): Promise<CartDto> => {
    const cart = await openCart(ctx, input.guestToken);
    await repository.clear(ctx.tx, cart.id);
    await repository.touch(ctx.tx, cart.id, ctx.now);
    return toCartDto(ctx.tx, cart, deps.defaultCurrency);
  };

  return {
    commands: [
      { descriptor: addToCartCommand, handler: addToCartHandler },
      { descriptor: setCartItemQuantityCommand, handler: setCartItemQuantityHandler },
      { descriptor: removeCartItemCommand, handler: removeCartItemHandler },
      { descriptor: clearCartCommand, handler: clearCartHandler },
    ],
  };
}

export { PlatformError };
