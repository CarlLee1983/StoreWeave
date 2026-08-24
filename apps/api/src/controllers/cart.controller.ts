import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PlatformError } from '@storeweave/contracts';
import { BusController } from './base';
import { ok } from '../http/envelope';
import { Public, actorOf, correlationIdOf, type AuthenticatedRequest } from '../http/auth';
import { existingGuestToken, guestTokenFor } from '../http/cart-cookie';
import { RUNTIME, type Runtime } from '../tokens';

@Public()
@Controller('api/v1/cart')
export class CartController extends BusController {
  constructor(@Inject(RUNTIME) runtime: Runtime) {
    super(runtime);
  }

  /** 讀取不簽發 token：讀一次就換一台新車，等於把「清空購物車」變成跨站點得到的開關。 */
  @Get()
  async get(@Req() req: AuthenticatedRequest) {
    const guestToken = existingGuestToken(req, this.runtime.config.http.publicUrl);
    return ok(await this.query(req, 'commerce.cart.getCart', { guestToken }));
  }

  @Post('items')
  async add(
    @Req() req: AuthenticatedRequest,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return ok(await this.command(req, 'commerce.cart.addToCart', {
      ...body,
      guestToken: this.guestToken(req, reply),
    }));
  }

  @Patch('items/:productId')
  async setQuantity(
    @Req() req: AuthenticatedRequest,
    @Param('productId') productId: string,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return ok(await this.command(req, 'commerce.cart.setCartItemQuantity', {
      productId,
      quantity: body.quantity,
      guestToken: this.guestToken(req, reply),
    }));
  }

  @Delete('items/:productId')
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('productId') productId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return ok(await this.command(req, 'commerce.cart.removeCartItem', {
      productId,
      guestToken: this.guestToken(req, reply),
    }));
  }

  /**
   * 購物車結帳。冪等鍵取自購物車識別碼——重複送出的表單不會帶對 `Idempotency-Key`，
   * 而每次現產一個隨機值等於沒有保護（工單 28 修掉的就是這個缺陷）。
   *
   * `cartId` 由畫面帶回來：結完帳那台車就關了，重送的請求若改問「現在的車」
   * 會問到一台新的空車，然後回一個看不懂的錯誤，而不是原本那張訂單。
   */
  @Post('checkout')
  async checkout(@Req() req: AuthenticatedRequest, @Body() body: Record<string, unknown>) {
    const cartId = typeof body?.cartId === 'string' ? body.cartId : await this.currentCartId(req);

    const actor = actorOf(req);
    return ok(await this.runtime.commands.execute('commerce.order.checkoutCart',
      {
        cartId,
        shippingMethodId: body.shippingMethodId,
        destination: body.destination,
      },
      // 鍵綁上身分：冪等鍵是猜得到的（購物車識別碼），而它決定了誰讀得到那份回應。
      { actor, idempotencyKey: `cart:${actor.id}:${cartId}`, correlationId: correlationIdOf(req), channel: 'rest' }));
  }

  /** 套用折扣碼。這支端點受節流保護：沒有它，掃碼機器人可以把限量活動吃光。 */
  @Post('coupon')
  async applyCoupon(
    @Req() req: AuthenticatedRequest,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return ok(await this.command(req, 'commerce.cart.applyCoupon', {
      code: body.code,
      guestToken: this.guestToken(req, reply),
    }));
  }

  /** 設定要折抵多少購物金。訪客沒有帳本，因此這支只對會員有意義。 */
  @Post('rewards')
  async setRewardRedemption(@Req() req: AuthenticatedRequest, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.cart.setRewardRedemption', { amountCents: body.amountCents }));
  }

  @Delete('coupon')
  async removeCoupon(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return ok(await this.command(req, 'commerce.cart.removeCoupon', { guestToken: this.guestToken(req, reply) }));
  }

  @Delete()
  async clear(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return ok(await this.command(req, 'commerce.cart.clearCart', { guestToken: this.guestToken(req, reply) }));
  }

  /**
   * 沒帶 `cartId` 時的退路：問「現在的車」。
   *
   * 這次查詢必須帶上既有的訪客 token（與 `GET /api/v1/cart` 同一支讀法，不簽發新的），
   * 否則訪客問到的是一台跟他無關的車。而 `getCart` 對「還沒有車」的人回的是一台
   * **現產的**空車——那個 uuid 在資料庫裡不存在，拿去結帳只會換來一個指著陌生識別碼的 404。
   * 空車在這裡就結束（工單 52）。這句話與 `checkoutCart` 對空車的說法**不共用**同一份宣告：
   * apps/api 對任何 commerce 模組都沒有相依（ADR 0010），為了一句訊息開這個相依不划算。
   * 兩邊各自成立——這裡說的是「沒有車可以結」，命令說的是「這台車沒有結得了的商品」。
   *
   * 判準也不同：這裡數的是購物車顯示的行數，命令數的是 `isPurchasable` 過濾後的行。
   * 一台只剩下架商品的車會穿過這個預檢查，然後被命令擋下——結局一樣，理由不一樣。
   */
  private async currentCartId(req: AuthenticatedRequest): Promise<string> {
    const guestToken = existingGuestToken(req, this.runtime.config.http.publicUrl);
    const cart = await this.query<{ id: string; items: unknown[] }>(req, 'commerce.cart.getCart', { guestToken });
    if (cart.items.length === 0) throw PlatformError.validation('No cart to check out');
    return cart.id;
  }

  /**
   * 訪客第一次碰購物車時發一張 token；會員不發，也不用既有的那張——
   * 登入的那一刻兩台車就合併了（工單 27），身分與 token 不會同時生效。
   */
  private guestToken(req: AuthenticatedRequest, reply: FastifyReply): string | undefined {
    return guestTokenFor(req, reply, this.runtime.config.http.publicUrl);
  }
}
