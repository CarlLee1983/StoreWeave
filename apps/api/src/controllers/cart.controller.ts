import { randomBytes } from 'node:crypto';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { BusController } from './base';
import { ok } from '../http/envelope';
import { Public, type AuthenticatedRequest } from '../http/auth';
import { RUNTIME, type Runtime } from '../tokens';

/** 訪客購物車的識別碼。會員不需要它——他們的車綁在身分上。 */
export const CART_COOKIE = 'commerce_cart';
const CART_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

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
   * 兩台車的合併是工單 27 的事，在那之前不要讓身分與 token 同時生效。
   */
  private guestToken(req: AuthenticatedRequest, reply: FastifyReply): string | undefined {
    if (req.actor?.type === 'customer') return undefined;

    const existing = req.cookies?.[CART_COOKIE];
    if (existing) return existing;

    const token = randomBytes(32).toString('base64url');
    const { protocol, hostname } = new URL(this.runtime.config.http.publicUrl);
    const secure = protocol === 'https:' || !['localhost', '127.0.0.1', '::1'].includes(hostname);
    reply.setCookie(CART_COOKIE, token, {
      path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: CART_COOKIE_MAX_AGE,
    });
    return token;
  }
}
