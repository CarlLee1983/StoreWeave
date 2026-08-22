import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { BusController } from './base';
import { ok } from '../http/envelope';
import { Public, actorOf, correlationIdOf, type AuthenticatedRequest } from '../http/auth';
import { guestTokenFor } from '../http/cart-cookie';
import { RUNTIME, type Runtime } from '../tokens';

@Public()
@Controller('api/v1/cart')
export class CartController extends BusController {
  constructor(@Inject(RUNTIME) runtime: Runtime) {
    super(runtime);
  }

  @Get()
  async get(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return ok(await this.query(req, 'commerce.cart.getCart', { guestToken: this.guestToken(req, reply) }));
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

    return ok(await this.runtime.commands.execute('commerce.order.checkoutCart',
      { cartId, metadata: body?.metadata },
      { actor: actorOf(req), idempotencyKey: `cart:${cartId}`, correlationId: correlationIdOf(req), channel: 'rest' }));
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
