import { createHash, randomUUID } from 'node:crypto';
import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PlatformError, type Actor } from '@storeweave/contracts';
import { csrfTokenFor } from '@storeweave/identity';
import type { StorefrontTheme, ThemeContext } from '@storeweave/kernel';
import type { NotificationProvider } from '@storeweave/extension-sdk';
import { Anonymous, Public, SESSION_COOKIE, actorOf, anonymousActor, type AuthenticatedRequest } from '../http/auth';
import { clearSessionCookies, setSessionCookies } from '../http/session-cookies';
import { RUNTIME, THEME, type Runtime } from '../tokens';

/** 重設連結的時效。夠久到收得到信，短到外洩的信件不會長期有效。 */
const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * 只接受站內路徑，避免變成開放轉址。
 *
 * 用 URL 解析而不是字串前綴：特殊 scheme 下反斜線等同斜線，tab / CR / LF 又會在
 * 解析前被剝掉，`/\evil.com` 與 `/<TAB>/evil.com` 都會被瀏覽器當成 protocol-relative。
 * 追這種邊角只能交給解析器。
 */
function safeNext(value: string | undefined): string {
  if (!value) return '/';
  const cleaned = value.replace(/[\t\r\n]/g, '');
  try {
    const parsed = new URL(cleaned, 'https://internal.invalid');
    if (parsed.origin !== 'https://internal.invalid') return '/';
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return path.startsWith('/') && !path.startsWith('//') ? path : '/';
  } catch {
    return '/';
  }
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
      // 有 session 就發 token：守衛對任何 cookie 身分都會驗 CSRF，只發給顧客的話，
      // 後台身分逛前台送出表單會拿到裸的 403，而不是那句「請先登入」。
      csrfToken: sessionToken && actor && actor.type !== 'service' ? csrfTokenFor(sessionToken) : null,
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

  @Get('account/profile')
  async profilePage(@Req() req: AuthenticatedRequest, @Res() reply: FastifyReply) {
    const actor = actorOf(req);
    if (actor.type !== 'customer') {
      void reply.status(303).header('location', `/login?next=${encodeURIComponent('/account/profile')}`).send();
      return;
    }
    await this.renderProfile(req, reply, {});
  }

  @Post('account/profile')
  async saveProfile(@Req() req: AuthenticatedRequest, @Body() body: Record<string, string>, @Res() reply: FastifyReply) {
    const actor = actorOf(req);
    if (actor.type !== 'customer') {
      void reply.status(303).header('location', `/login?next=${encodeURIComponent('/account/profile')}`).send();
      return;
    }

    const address = body.line1?.trim()
      ? {
          recipient: body.recipient ?? '',
          phone: body.addressPhone ?? '',
          postcode: body.postcode ?? '',
          city: body.city ?? '',
          line1: body.line1,
          line2: body.line2?.trim() ? body.line2 : null,
        }
      : undefined;

    try {
      await this.runtime.commands.execute('commerce.customer.updateMyProfile', {
        displayName: body.displayName || undefined,
        phone: body.phone?.trim() ? body.phone : undefined,
        birthday: body.birthday?.trim() ? body.birthday : undefined,
        address,
      }, { actor, channel: 'rest' });
      await this.renderProfile(req, reply, { saved: true });
    } catch (err) {
      const message = err instanceof PlatformError && err.httpStatus < 500 ? err.message : '儲存失敗，請稍後再試。';
      await this.renderProfile(req, reply, { error: message });
    }
  }

  private async renderProfile(
    req: AuthenticatedRequest,
    reply: FastifyReply,
    extra: { saved?: boolean; error?: string },
  ) {
    const profile = await this.runtime.queries.execute<any>(
      'commerce.customer.getMyProfile', {}, { actor: actorOf(req), channel: 'rest' },
    );
    this.html(reply, 200, this.theme.renderAccountProfile(this.themeContext(req), {
      displayName: profile.displayName,
      phone: profile.phone,
      birthday: profile.birthday,
      address: profile.address,
      ...extra,
    }));
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
  @Get('forgot-password')
  async forgotPasswordPage(@Res() reply: FastifyReply) {
    this.html(reply, 200, this.theme.renderAuth(this.themeContext(), { mode: 'forgot-password', next: '/' }));
  }

  @Anonymous()
  @Post('forgot-password')
  async forgotPassword(@Body() body: Record<string, string>, @Res() reply: FastifyReply) {
    // 回應一律中性：區分「寄了」與「沒這個帳號」等於送出帳號枚舉管道。
    const neutral = '若這個電子郵件存在，我們已經把重設連結寄出去了。';
    try {
      const created = await this.runtime.auth.createPasswordReset(this.runtime.database.db, {
        email: body.email ?? '',
        ttlMs: RESET_TTL_MS,
      });
      if (created) {
        const provider = this.runtime.providers.get<NotificationProvider>('notification');
        await provider.send({
          template: 'customer.password-reset',
          to: { email: created.user.email, name: created.user.displayName },
          variables: {
            resetUrl: `${this.runtime.config.http.publicUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(created.token)}`,
            expiresInMinutes: RESET_TTL_MS / 60_000,
          },
          // reference 會被 Provider 留存，因此用不可逆的值——明文 token 只該出現在信裡。
          reference: `password-reset:${createHash('sha256').update(created.token).digest('base64url').slice(0, 32)}`,
        });
      }
    } catch (err) {
      // 寄信失敗也不改變對外的訊息，只留在 log 裡——否則它就是那條枚舉管道。
      this.runtime.logger.error({ error: (err as Error).message }, 'password reset delivery failed');
    }
    this.html(reply, 200, this.theme.renderAuth(this.themeContext(), {
      mode: 'forgot-password', next: '/', notice: neutral,
    }));
  }

  @Anonymous()
  @Get('reset-password')
  async resetPasswordPage(@Query('token') token: string | undefined, @Res() reply: FastifyReply) {
    this.html(reply, 200, this.theme.renderAuth(this.themeContext(), {
      mode: 'reset-password', next: '/', token: token ?? '',
    }));
  }

  @Anonymous()
  @Post('reset-password')
  async resetPassword(@Body() body: Record<string, string>, @Res() reply: FastifyReply) {
    try {
      await this.runtime.auth.resetPassword(this.runtime.database.db, {
        token: body.token ?? '',
        newPassword: body.password ?? '',
      });
      void reply.status(303).header('location', '/login').send();
    } catch (err) {
      const message = err instanceof PlatformError && err.httpStatus < 500 ? err.message : '設定新密碼失敗，請重新申請一次。';
      this.html(reply, 400, this.theme.renderAuth(this.themeContext(), {
        mode: 'reset-password', next: '/', token: body.token ?? '', error: message,
      }));
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
      // 已存在的帳號不能在這裡說出來——那是一條比登入更明確的帳號枚舉管道。
      // 驗證錯誤（密碼太短、email 格式）才照實說，因為它們與帳號存不存在無關。
      const isConflict = err instanceof PlatformError && err.code === 'CONFLICT';
      const message = isConflict
        ? '無法用這組資料註冊。如果你已經有帳號，請改用登入或密碼重設。'
        : err instanceof PlatformError && err.httpStatus < 500
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
