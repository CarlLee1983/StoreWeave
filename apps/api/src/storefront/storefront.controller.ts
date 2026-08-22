import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PlatformError, type Actor } from '@storeweave/contracts';
import type { StorefrontTheme, ThemeContext } from '@storeweave/kernel';
import { Anonymous, Public, actorOf, type AuthenticatedRequest } from '../http/auth';
import { RUNTIME, THEME, type Runtime } from '../tokens';

interface ProductDtoShape {
  id: string; sku: string; name: string; description: string | null;
  priceCents: number; currency: string; status: string;
}

/**
 * 預設 Storefront：NestJS SSR，畫面完全由 Theme 決定。
 * 這裡同樣只呼叫 Command / Query Bus。
 */
@Public()
@Controller()
export class StorefrontController {
  constructor(
    @Inject(RUNTIME) private readonly runtime: Runtime,
    @Inject(THEME) private readonly theme: StorefrontTheme,
  ) {}

  private themeContext(): ThemeContext {
    const store = this.runtime.config.store;
    return {
      storeName: store.name,
      storeId: store.id,
      currency: store.currency,
      locale: store.locale,
      publicUrl: this.runtime.config.http.publicUrl,
      supportEmail: store.supportEmail,
      options: this.runtime.config.theme.options,
    };
  }

  private html(reply: FastifyReply, status: number, body: string) {
    void reply.status(status).header('content-type', 'text/html; charset=utf-8').send(body);
  }

  @Get()
  async home(@Req() req: AuthenticatedRequest, @Res() reply: FastifyReply) {
    const actor = actorOf(req);
    const result = await this.runtime.queries.execute<{ items: ProductDtoShape[] }>(
      'commerce.catalog.searchProducts',
      { status: 'active', limit: 48, offset: 0 },
      { actor, channel: 'rest' },
    );
    const products = await Promise.all(result.items.map((p) => this.withStock(actor, p)));
    this.html(reply, 200, this.theme.renderHome(this.themeContext(), { products }));
  }

  @Get('p/:id')
  async product(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Res() reply: FastifyReply) {
    const actor = actorOf(req);
    try {
      const product = await this.runtime.queries.execute<ProductDtoShape>(
        'commerce.catalog.getProduct', { id }, { actor, channel: 'rest' },
      );
      this.html(reply, 200, this.theme.renderProduct(this.themeContext(), { product: await this.withStock(actor, product) }));
    } catch (err) {
      this.renderError(reply, err);
    }
  }

  @Get('orders/:number')
  async order(@Req() req: AuthenticatedRequest, @Param('number') number: string, @Res() reply: FastifyReply) {
    const actor = actorOf(req);
    try {
      const order = await this.runtime.queries.execute<any>(
        'commerce.order.getOrder', { number }, { actor, channel: 'rest' },
      );
      this.html(reply, 200, this.theme.renderOrder(this.themeContext(), { order }));
    } catch (err) {
      this.renderError(reply, err);
    }
  }

  /** 下單後立即排入付款工作，訂單頁呈現處理中的狀態。 */
  @Anonymous()
  @Post('checkout')
  async checkout(@Req() req: AuthenticatedRequest, @Body() body: Record<string, string>, @Res() reply: FastifyReply) {
    const actor = actorOf(req);
    try {
      const quantity = Number.parseInt(body.quantity ?? '1', 10);
      const correlationId = randomUUID();
      const order = await this.runtime.commands.execute<{ id: string; number: string }>(
        'commerce.order.placeOrder',
        { customerEmail: body.customerEmail, lines: [{ productId: body.productId, quantity }] },
        { actor, idempotencyKey: `storefront:${correlationId}`, correlationId, channel: 'rest' },
      );
      await this.runtime.commands.execute('commerce.order.payOrder', { orderId: order.id }, {
        actor, idempotencyKey: `storefront-pay:${order.id}`, correlationId, channel: 'rest',
      });
      void reply.status(303).header('location', `/orders/${order.number}`).send();
    } catch (err) {
      this.renderError(reply, err);
    }
  }

  private async withStock(actor: Actor, product: ProductDtoShape) {
    let available: number | null = null;
    try {
      const stock = await this.runtime.queries.execute<{ available: number }>(
        'commerce.inventory.getStock', { productId: product.id }, { actor, channel: 'rest' },
      );
      available = stock.available;
    } catch {
      available = null;
    }
    return { ...product, available };
  }

  private renderError(reply: FastifyReply, err: unknown) {
    const status = err instanceof PlatformError ? err.httpStatus : 500;
    const message = err instanceof PlatformError && status < 500 ? err.message : '發生未預期的錯誤';
    if (status >= 500) this.runtime.logger.error({ error: (err as Error).message }, 'storefront error');
    this.html(reply, status, this.theme.renderError(this.themeContext(), { status, message }));
  }
}
