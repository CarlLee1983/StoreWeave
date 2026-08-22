import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
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
    return ok(await this.query(req, 'commerce.cart.getCart', { guestToken: existingGuestToken(req) }));
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
    const cartId = typeof body?.cartId === 'string'
      ? body.cartId
      : (await this.query<{ id: string }>(req, 'commerce.cart.getCart', {})).id;

    const actor = actorOf(req);
    return ok(await this.runtime.commands.execute('commerce.order.checkoutCart',
      { cartId },
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

  @Delete('coupon')
  async removeCoupon(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return ok(await this.command(req, 'commerce.cart.removeCoupon', { guestToken: this.guestToken(req, reply) }));
  }

  @Delete()
  async clear(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return ok(await this.command(req, 'commerce.cart.clearCart', { guestToken: this.guestToken(req, reply) }));
  }

  /**
   * 訪客第一次碰購物車時發一張 token；會員不發，也不用既有的那張——
   * 登入的那一刻兩台車就合併了（工單 27），身分與 token 不會同時生效。
   */
  private guestToken(req: AuthenticatedRequest, reply: FastifyReply): string | undefined {
    return guestTokenFor(req, reply, this.runtime.config.http.publicUrl);
  }
}
