import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PlatformError, type Actor } from '@storeweave/contracts';
import { csrfTokenFor } from '@storeweave/identity';
import type { StorefrontTheme, ThemeContext } from '@storeweave/kernel';
import { Anonymous, Public, SESSION_COOKIE, actorOf, anonymousActor, type AuthenticatedRequest } from '../http/auth';
import { clearSessionCookies, setSessionCookies } from '../http/session-cookies';
import { RUNTIME, THEME, type Runtime } from '../tokens';

/** 只接受站內路徑，避免變成開放轉址。 */
function safeNext(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

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

  private themeContext(req?: AuthenticatedRequest): ThemeContext {
    const store = this.runtime.config.store;
    const sessionToken = req?.cookies?.[SESSION_COOKIE];
    const actor = req?.actor;
    return {
      storeName: store.name,
      storeId: store.id,
      currency: store.currency,
      locale: store.locale,
      publicUrl: this.runtime.config.http.publicUrl,
      supportEmail: store.supportEmail,
      options: this.runtime.config.theme.options,
      customerName: actor?.type === 'customer' ? actor.displayName ?? null : null,
      // 只有真的解析出身分時才給 token：強制匿名的頁面沒有身分可以被冒用。
      csrfToken: actor?.type === 'customer' && sessionToken ? csrfTokenFor(sessionToken) : null,
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
    this.html(reply, 200, this.theme.renderHome(this.themeContext(req), { products }));
  }

  @Get('p/:id')
  async product(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Res() reply: FastifyReply) {
    const actor = actorOf(req);
    try {
      const product = await this.runtime.queries.execute<ProductDtoShape>(
        'commerce.catalog.getProduct', { id }, { actor, channel: 'rest' },
      );
      this.html(reply, 200, this.theme.renderProduct(this.themeContext(req), { product: await this.withStock(actor, product) }));
    } catch (err) {
      this.renderError(reply, err, req);
    }
  }

  @Get('account/orders')
  async accountOrders(
    @Req() req: AuthenticatedRequest,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const actor = actorOf(req);
    if (actor.type !== 'customer') {
      void reply.status(303).header('location', `/login?next=${encodeURIComponent('/account/orders')}`).send();
      return;
    }

    try {
      // 範圍過濾在 query handler：這裡不必、也不該自己加條件（工單 12）。
      const result = await this.runtime.queries.execute<{ items: any[]; total: number }>(
        'commerce.order.listOrders',
        { limit: limit ?? 20, offset: offset ?? 0 },
        { actor, channel: 'rest' },
      );
      this.html(reply, 200, this.theme.renderAccountOrders(this.themeContext(req), {
        orders: result.items.map((order) => ({
          number: order.number,
          status: order.status,
          currency: order.currency,
          totalCents: order.totalCents,
          placedAt: order.placedAt,
          lineCount: order.lines.length,
        })),
        limit: Number(limit ?? 20),
        offset: Number(offset ?? 0),
        total: result.total,
      }));
    } catch (err) {
      this.renderError(reply, err, req);
    }
  }

  @Get('orders/:number')
  async order(@Req() req: AuthenticatedRequest, @Param('number') number: string, @Res() reply: FastifyReply) {
    const actor = actorOf(req);
    if (actor.type !== 'customer') {
      void reply.status(303).header('location', `/login?next=${encodeURIComponent(`/orders/${number}`)}`).send();
      return;
    }
    try {
      const order = await this.runtime.queries.execute<any>(
        'commerce.order.getOrder', { number }, { actor, channel: 'rest' },
      );
      this.html(reply, 200, this.theme.renderOrder(this.themeContext(req), { order }));
    } catch (err) {
      this.renderError(reply, err, req);
    }
  }

  /** 下單後立即排入付款工作，訂單頁呈現處理中的狀態。 */
  @Post('checkout')
  async checkout(@Req() req: AuthenticatedRequest, @Body() body: Record<string, string>, @Res() reply: FastifyReply) {
    const actor = actorOf(req);
    // 結帳需要身分。未登入不是錯誤，是「先去登入，然後回到這裡」。
    if (actor.type !== 'customer') {
      void reply.status(303).header('location', `/login?next=${encodeURIComponent(`/p/${body.productId ?? ''}`)}`).send();
      return;
    }
    try {
      const quantity = Number.parseInt(body.quantity ?? '1', 10);
      const correlationId = randomUUID();
      const order = await this.runtime.commands.execute<{ id: string; number: string }>(
        'commerce.order.placeOrder',
        { lines: [{ productId: body.productId, quantity }] },
        { actor, idempotencyKey: `storefront:${correlationId}`, correlationId, channel: 'rest' },
      );
      await this.runtime.commands.execute('commerce.order.payOrder', { orderId: order.id }, {
        actor, idempotencyKey: `storefront-pay:${order.id}`, correlationId, channel: 'rest',
      });
      void reply.status(303).header('location', `/orders/${order.number}`).send();
    } catch (err) {
      this.renderError(reply, err, req);
    }
  }

  @Anonymous()
  @Get('login')
  async loginPage(@Query('next') next: string | undefined, @Res() reply: FastifyReply) {
    this.html(reply, 200, this.theme.renderAuth(this.themeContext(), { mode: 'login', next: safeNext(next) }));
  }

  @Anonymous()
  @Get('register')
  async registerPage(@Query('next') next: string | undefined, @Res() reply: FastifyReply) {
    this.html(reply, 200, this.theme.renderAuth(this.themeContext(), { mode: 'register', next: safeNext(next) }));
  }

  @Anonymous()
  @Post('login')
  async login(@Body() body: Record<string, string>, @Res() reply: FastifyReply) {
    const next = safeNext(body.next);
    try {
      const session = await this.runtime.auth.authenticate(this.runtime.database.db, {
        email: body.email,
        password: body.password,
      });
      this.startSession(reply, session.token, session.expiresAt);
      void reply.status(303).header('location', next).send();
    } catch {
      // 訊息一律中性：區分「沒這個帳號」與「密碼錯」等於送出帳號枚舉管道。
      this.html(reply, 401, this.theme.renderAuth(this.themeContext(), {
        mode: 'login', next, error: '電子郵件或密碼不正確。',
      }));
    }
  }

  @Anonymous()
  @Post('register')
  async register(@Body() body: Record<string, string>, @Res() reply: FastifyReply) {
    const next = safeNext(body.next);
    try {
      await this.runtime.commands.execute('commerce.customer.registerCustomer', {
        email: body.email,
        password: body.password,
        displayName: body.displayName || undefined,
      }, { actor: anonymousActor(), channel: 'rest' });

      // 註冊完直接登入：讓人再打一次同一組密碼沒有任何意義。
      const session = await this.runtime.auth.authenticate(this.runtime.database.db, {
        email: body.email,
        password: body.password,
      });
      this.startSession(reply, session.token, session.expiresAt);
      void reply.status(303).header('location', next).send();
    } catch (err) {
      const message = err instanceof PlatformError && err.httpStatus < 500
        ? err.message
        : '註冊失敗，請稍後再試。';
      this.html(reply, 400, this.theme.renderAuth(this.themeContext(), { mode: 'register', next, error: message }));
    }
  }

  // 強制匿名：HTML 表單送不出 CSRF header，而被強制登出是干擾而不是資料外洩。
  @Anonymous()
  @Post('logout')
  async logout(@Req() req: AuthenticatedRequest, @Res() reply: FastifyReply) {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await this.runtime.auth.revokeSession(this.runtime.database.db, token);
    clearSessionCookies(reply as never, this.runtime.config.http.publicUrl);
    void reply.status(303).header('location', '/').send();
  }

  private startSession(reply: FastifyReply, token: string, expiresAt: Date): void {
    setSessionCookies(reply as never, { publicUrl: this.runtime.config.http.publicUrl, token, expiresAt });
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

  private renderError(reply: FastifyReply, err: unknown, req?: AuthenticatedRequest) {
    const status = err instanceof PlatformError ? err.httpStatus : 500;
    const message = err instanceof PlatformError && status < 500 ? err.message : '發生未預期的錯誤';
    if (status >= 500) this.runtime.logger.error({ error: (err as Error).message }, 'storefront error');
    this.html(reply, status, this.theme.renderError(this.themeContext(req), { status, message }));
  }
}
