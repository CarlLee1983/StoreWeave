import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext } from '@storeweave/contracts';
import { catalogService } from '@storeweave/catalog';
import { couponError, couponService } from '@storeweave/coupon';
import {
  addToCartInput,
  cartDto,
  clearCartInput,
  mergeGuestCartInput,
  mergedCartDto,
  applyCouponInput,
  removeCouponInput,
  setRewardRedemptionInput,
  GUEST_CART_RETENTION_DAYS,
  purgeStaleGuestCartsInput,
  purgeStaleGuestCartsOutput,
  removeCartItemInput,
  setCartItemQuantityInput,
  type CartDto,
  type MergedCartDto,
} from './dto';
import { CartRepository, resolveOwner } from './repository';
import { isPurchasable, toCartDto } from './service';

const repository = new CartRepository();

export interface CartModuleDeps {
  defaultCurrency: string;
}

/**
 * 加入購物車前確認商品真的買得到——下架的商品不該先進車再在結帳時才失敗。
 * 幣別也在這裡擋：混幣別的商品進不了同一張訂單，讓它進車只會製造一個移不掉的行。
 */
async function requirePurchasable(ctx: CommandContext, productId: string, defaultCurrency: string): Promise<void> {
  const product = await catalogService.requireActiveProduct(ctx.tx, productId);
  if (product.currency !== defaultCurrency) {
    throw PlatformError.validation(`Product ${product.sku} is priced in ${product.currency}, this store sells in ${defaultCurrency}`);
  }
}

/**
 * 取得（必要時開一台）這次要寫入的購物車，並**鎖住那一列**。
 *
 * 結帳也是鎖同一列（`lockById`）。不鎖的話，加入或合併可能落在一台正在結帳、
 * 甚至已經 checked_out 的車上——那些商品行從此只存在於一台沒有查詢找得到的車裡，
 * 顧客看不到也拿不回。這不是金錢損失，是靜默的資料遺失。
 */
async function openCart(ctx: CommandContext, guestToken: string | undefined) {
  const owner = await resolveOwner(ctx.tx, ctx.actor, guestToken);
  const cart = await repository.findOrCreate(ctx.tx, owner, ctx.now);
  const locked = await repository.lockById(ctx.tx, cart.id);
  // 等到鎖之後那台車已經被結掉，就開一台新的：顧客的下一件商品要有地方放。
  if (locked && locked.status === 'open') return locked;
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
    await requirePurchasable(ctx, input.productId, deps.defaultCurrency);
    const cart = await openCart(ctx, input.guestToken);
    // 再加一次同一件商品是累加：使用者的意圖是「再來一個」，不是「覆蓋成一個」。
    await repository.addQuantity(ctx.tx, cart.id, input.productId, input.quantity, ctx.now);
    await repository.touch(ctx.tx, cart.id, ctx.now);
    return toCartDto(ctx.tx, cart, deps.defaultCurrency, ctx.now, ctx.logger);
  };

  const setCartItemQuantityHandler = async (
    input: z.infer<typeof setCartItemQuantityInput>,
    ctx: CommandContext,
  ): Promise<CartDto> => {
    const cart = await openCart(ctx, input.guestToken);
    if (input.quantity === 0) {
      await repository.removeItem(ctx.tx, cart.id, input.productId);
    } else {
      await requirePurchasable(ctx, input.productId, deps.defaultCurrency);
      await repository.setQuantity(ctx.tx, cart.id, input.productId, input.quantity, ctx.now);
    }
    await repository.touch(ctx.tx, cart.id, ctx.now);
    return toCartDto(ctx.tx, cart, deps.defaultCurrency, ctx.now, ctx.logger);
  };

  const removeCartItemHandler = async (
    input: z.infer<typeof removeCartItemInput>,
    ctx: CommandContext,
  ): Promise<CartDto> => {
    const cart = await openCart(ctx, input.guestToken);
    await repository.removeItem(ctx.tx, cart.id, input.productId);
    await repository.touch(ctx.tx, cart.id, ctx.now);
    return toCartDto(ctx.tx, cart, deps.defaultCurrency, ctx.now, ctx.logger);
  };

  const mergeGuestCartCommand = defineCommand({
    name: 'commerce.cart.mergeGuestCart',
    summary: '把訪客購物車併入會員購物車',
    input: mergeGuestCartInput,
    output: mergedCartDto,
    permission: 'cart:write',
    idempotency: 'optional',
    audit: {
      action: 'cart.merged',
      resourceType: 'cart',
      resourceId: (_i, o: MergedCartDto) => o.id,
      redact: () => ({}),
    },
  });

  /**
   * 登入的那一刻把訪客車併進會員車。
   *
   * 同一件商品兩邊都有時取**較大**數量而不是相加：在兩個裝置各放一件的人，
   * 意圖幾乎總是「我要一件」。相加會製造客訴。
   *
   * 下架的商品進不了會員車，但要說得出被拿掉的是什麼——靜默消失比消失更糟。
   */
  const mergeGuestCartHandler = async (
    input: z.infer<typeof mergeGuestCartInput>,
    ctx: CommandContext,
  ): Promise<MergedCartDto> => {
    if (ctx.actor.type !== 'customer') {
      throw PlatformError.forbidden('Merging a guest cart needs a signed-in customer');
    }
    const target = await openCart(ctx, undefined);
    const guest = await repository.findGuestCart(ctx.tx, input.guestToken);
    if (!guest) {
      return { ...(await toCartDto(ctx.tx, target, deps.defaultCurrency, ctx.now, ctx.logger)), removedNames: [] };
    }

    const mine = new Map((await repository.items(ctx.tx, target.id)).map((row) => [row.productId, row.quantity]));
    const removedNames: string[] = [];

    for (const row of await repository.items(ctx.tx, guest.id)) {
      const product = await catalogService.findById(ctx.tx, row.productId);
      if (!product || !isPurchasable(product, deps.defaultCurrency)) {
        // 商品連紀錄都沒了就講不出名字，這時候不編一個——只是不提它。
        if (product) removedNames.push(product.name);
        continue;
      }
      const quantity = Math.max(row.quantity, mine.get(row.productId) ?? 0);
      await repository.setQuantity(ctx.tx, target.id, row.productId, quantity, ctx.now);
    }

    await repository.markMerged(ctx.tx, guest.id, ctx.now);
    await repository.touch(ctx.tx, target.id, ctx.now);
    return {
      ...(await toCartDto(ctx.tx, target, deps.defaultCurrency, ctx.now, ctx.logger)),
      removedNames,
    };
  };

  const clearCartHandler = async (input: z.infer<typeof clearCartInput>, ctx: CommandContext): Promise<CartDto> => {
    const cart = await openCart(ctx, input.guestToken);
    await repository.clear(ctx.tx, cart.id);
    await repository.touch(ctx.tx, cart.id, ctx.now);
    return toCartDto(ctx.tx, cart, deps.defaultCurrency, ctx.now, ctx.logger);
  };

  const applyCouponCommand = cartCommand('commerce.cart.applyCoupon', '套用折扣碼', applyCouponInput, 'cart.coupon-applied');
  const removeCouponCommand = cartCommand('commerce.cart.removeCoupon', '移除折扣碼', removeCouponInput, 'cart.coupon-removed');

  /**
   * 套用折扣碼。當場就驗，理由分得細——顧客看到「無效」只會再打一次，
   * 看到「已過期」才會去找別張。
   *
   * 這裡**不**扣任何額度：限量的扣減只發生在結帳（工單 32）。
   */
  const applyCouponHandler = async (input: z.infer<typeof applyCouponInput>, ctx: CommandContext): Promise<CartDto> => {
    const cart = await openCart(ctx, input.guestToken);
    const resolved = await couponService.resolve(ctx.tx, {
      code: input.code,
      customerId: cart.customerId,
      now: ctx.now,
    });
    if (!resolved.ok) throw couponError(resolved.reason);

    await repository.setCouponCode(ctx.tx, cart.id, resolved.coupon.code, ctx.now);
    return toCartDto(ctx.tx, { ...cart, couponCode: resolved.coupon.code }, deps.defaultCurrency, ctx.now, ctx.logger);
  };

  const removeCouponHandler = async (input: z.infer<typeof removeCouponInput>, ctx: CommandContext): Promise<CartDto> => {
    const cart = await openCart(ctx, input.guestToken);
    await repository.setCouponCode(ctx.tx, cart.id, null, ctx.now);
    return toCartDto(ctx.tx, { ...cart, couponCode: null }, deps.defaultCurrency, ctx.now, ctx.logger);
  };

  const setRewardRedemptionCommand = defineCommand({
    name: 'commerce.cart.setRewardRedemption',
    summary: '設定要折抵多少購物金',
    input: setRewardRedemptionInput,
    output: cartDto,
    permission: 'cart:write',
    idempotency: 'optional',
    audit: {
      action: 'cart.reward-redemption-set',
      resourceType: 'cart',
      resourceId: (_i, o: CartDto) => o.id,
      redact: (i) => ({ amountCents: i.amountCents }),
    },
  });

  /**
   * 存的是「顧客希望折多少」，不是「實際折多少」：餘額與小計都會再變，
   * 實際折抵額在試算與結帳時各自重新夾限。存實際值等於把一個會過期的答案寫進資料庫。
   */
  const setRewardRedemptionHandler = async (
    input: z.infer<typeof setRewardRedemptionInput>,
    ctx: CommandContext,
  ): Promise<CartDto> => {
    if (ctx.actor.type !== 'customer') {
      throw PlatformError.forbidden('Redeeming rewards needs a signed-in customer');
    }
    const cart = await openCart(ctx, undefined);
    await repository.setRewardRedemption(ctx.tx, cart.id, input.amountCents, ctx.now);
    return toCartDto(
      ctx.tx,
      { ...cart, rewardRedeemCents: input.amountCents },
      deps.defaultCurrency,
      ctx.now,
      ctx.logger,
    );
  };

  const purgeStaleGuestCartsCommand = defineCommand({
    name: 'commerce.cart.purgeStaleGuestCarts',
    summary: '清除長期未更新的訪客購物車',
    input: purgeStaleGuestCartsInput,
    output: purgeStaleGuestCartsOutput,
    permission: 'cart:write',
    idempotency: 'optional',
    audit: {
      action: 'cart.purged',
      resourceType: 'cart',
      resourceId: () => 'stale-guest-carts',
      redact: () => ({}),
    },
  });

  /**
   * 訪客車三十天沒動就清掉，資料表才不會無限膨脹。會員的車永遠留著——
   * 棄單再行銷需要「最後更新於 N 天前」這個查詢問得出東西。
   *
   * 界線由呼叫端給得出來，測試才驗得到邊界而不必等三十天。
   */
  const purgeStaleGuestCartsHandler = async (
    input: z.infer<typeof purgeStaleGuestCartsInput>,
    ctx: CommandContext,
  ) => {
    const before = input.before ?? new Date(ctx.now.getTime() - GUEST_CART_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const deletedCarts = await repository.deleteStaleGuestCarts(ctx.tx, before);
    if (deletedCarts > 0) ctx.logger.info({ deletedCarts, before }, 'purged stale guest carts');
    return { deletedCarts, before };
  };

  return {
    commands: [
      { descriptor: addToCartCommand, handler: addToCartHandler },
      { descriptor: setCartItemQuantityCommand, handler: setCartItemQuantityHandler },
      { descriptor: removeCartItemCommand, handler: removeCartItemHandler },
      { descriptor: clearCartCommand, handler: clearCartHandler },
      { descriptor: mergeGuestCartCommand, handler: mergeGuestCartHandler },
      { descriptor: purgeStaleGuestCartsCommand, handler: purgeStaleGuestCartsHandler },
      { descriptor: applyCouponCommand, handler: applyCouponHandler },
      { descriptor: removeCouponCommand, handler: removeCouponHandler },
      { descriptor: setRewardRedemptionCommand, handler: setRewardRedemptionHandler },
    ],
  };
}

export { PlatformError };
