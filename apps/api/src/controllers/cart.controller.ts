import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { BusController } from './base';
import { ok } from '../http/envelope';
import { Public, type AuthenticatedRequest } from '../http/auth';
import { CART_COOKIE, setGuestCartCookie } from '../http/cart-cookie';
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

  @Delete()
  async clear(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return ok(await this.command(req, 'commerce.cart.clearCart', { guestToken: this.guestToken(req, reply) }));
  }

  /**
   * 訪客第一次碰購物車時發一張 token；會員不發，也不用既有的那張——
   * 登入的那一刻兩台車就合併了（工單 27），身分與 token 不會同時生效。
   */
  private guestToken(req: AuthenticatedRequest, reply: FastifyReply): string | undefined {
    if (req.actor?.type === 'customer') return undefined;
    return req.cookies?.[CART_COOKIE] ?? setGuestCartCookie(reply, this.runtime.config.http.publicUrl);
  }
}
