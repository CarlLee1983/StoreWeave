import { createHash, randomUUID } from 'node:crypto';
import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PlatformError, SYSTEM_ACTOR, type Actor } from '@storeweave/contracts';
import { csrfTokenFor } from '@storeweave/identity';
import type { StorefrontTheme, ThemeContext } from '@storeweave/kernel';
import type { NotificationProvider, PaymentProvider, ShippingProvider } from '@storeweave/extension-sdk';
import { customerService } from '@storeweave/customer';
import { Anonymous, ExternalCallback, Public, actorOf, anonymousActor, type AuthenticatedRequest } from '../http/auth';
import { clearSessionCookies, sessionTokenOf } from '../http/session-cookies';
import { cartNoticeOf, clearCartNoticeCookie, existingGuestToken, guestTokenFor } from '../http/cart-cookie';
import { startSession } from '../http/session-start';
import { RUNTIME, THEME, type Runtime } from '../tokens';

/** 重設連結的時效。夠久到收得到信，短到外洩的信件不會長期有效。 */
const RESET_TTL_MS = 60 * 60 * 1000;
const CATALOG_PAGE_SIZE = 24;

function catalogQuery(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw PlatformError.validation('Search query must be a single string');
  return value.trim();
}

function catalogPage(value: unknown): number {
  if (value === undefined || value === '') return 1;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw PlatformError.validation('Page must be a positive integer');
  }
  const page = Number(value);
  if (!Number.isSafeInteger(page) || (page - 1) * CATALOG_PAGE_SIZE > Number.MAX_SAFE_INTEGER) {
    throw PlatformError.validation('Page is too large');
  }
  return page;
}

function catalogPrice(value: unknown, label: string): number | null {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw PlatformError.validation(`${label} must be a nonnegative whole amount`);
  }
  const price = Number(value);
  if (!Number.isSafeInteger(price) || price > Math.floor(Number.MAX_SAFE_INTEGER / 100)) {
    throw PlatformError.validation(`${label} is too large`);
  }
  return price;
}

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

/** 帳本的來源代碼對顧客沒有意義。客服補償的原因有寫就照實顯示。 */
function rewardDescription(entry: { source: string; reason: string | null }): string {
  if (entry.reason) return entry.reason;
  switch (entry.source) {
    case 'order-accrual': return '購物回饋';
    case 'redemption': return '結帳折抵';
    case 'reversal': return '訂單取消回沖';
    default: return '調整';
  }
}

function formValues(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === 'string');
}

/** Only converts form shape; the RMA command rechecks order ownership and every quantity under lock. */
function rmaLinesFromForm(body: Record<string, unknown>) {
  return formValues(body.orderLineId).map((orderLineId) => ({
    orderLineId,
    quantity: typeof body[`quantity_${orderLineId}`] === 'string' ? Number(body[`quantity_${orderLineId}`]) : Number.NaN,
  }));
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

  /**
   * 一次性提示：讀到就清掉。合併發生在轉址之前，訊息沒有別的地方可以放。
   * 清除要落在同一個回應上，否則它會在每一頁重複出現。
   */
  private takeNotice(req?: AuthenticatedRequest, reply?: FastifyReply): string | null {
    const notice = cartNoticeOf(req, this.runtime.config.http.publicUrl);
    if (!notice) return null;
    if (reply) clearCartNoticeCookie(reply, this.runtime.config.http.publicUrl);
    return notice;
  }

  private themeContext(req?: AuthenticatedRequest, reply?: FastifyReply): ThemeContext {
    const store = this.runtime.config.store;
    const sessionToken = sessionTokenOf(req, this.runtime.config.http.publicUrl);
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
      notice: this.takeNotice(req, reply),
    };
  }

  private html(reply: FastifyReply, status: number, body: string) {
    void reply.status(status).header('content-type', 'text/html; charset=utf-8').send(body);
  }

  @Get()
  async home(
    @Req() req: AuthenticatedRequest,
    @Query('q') rawQuery: unknown,
    @Query('minPrice') rawMinPrice: unknown,
    @Query('maxPrice') rawMaxPrice: unknown,
    @Query('page') rawPage: unknown,
    @Res() reply: FastifyReply,
  ) {
    const actor = actorOf(req);
    try {
      const q = catalogQuery(rawQuery);
      const minPrice = catalogPrice(rawMinPrice, 'Minimum price');
      const maxPrice = catalogPrice(rawMaxPrice, 'Maximum price');
      if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
        throw PlatformError.validation('Maximum price must be greater than or equal to minimum price');
      }
      const page = catalogPage(rawPage);
      const result = await this.runtime.queries.execute<{ items: ProductDtoShape[]; total: number }>(
        'commerce.catalog.searchProducts',
        {
          ...(q ? { q } : {}),
          ...(minPrice !== null ? { minPriceCents: minPrice * 100 } : {}),
          ...(maxPrice !== null ? { maxPriceCents: maxPrice * 100 } : {}),
          status: 'active', limit: CATALOG_PAGE_SIZE, offset: (page - 1) * CATALOG_PAGE_SIZE,
        },
        { actor, channel: 'rest' },
      );
      const products = await Promise.all(result.items.map((p) => this.withStock(actor, p)));
      this.html(reply, 200, this.theme.renderHome(this.themeContext(req, reply), {
        products, q, minPrice, maxPrice, page, pageSize: CATALOG_PAGE_SIZE, total: result.total,
      }));
    } catch (err) {
      this.renderError(reply, err, req);
    }
  }

  @Get('p/:id')
  async product(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Res() reply: FastifyReply) {
    const actor = actorOf(req);
    try {
      const product = await this.runtime.queries.execute<ProductDtoShape>(
        'commerce.catalog.getProduct', { id }, { actor, channel: 'rest' },
      );
      if (product.status !== 'active') throw PlatformError.notFound('Product', id);
      this.html(reply, 200, this.theme.renderProduct(this.themeContext(req, reply), { product: await this.withStock(actor, product) }));
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
      this.html(reply, 200, this.theme.renderAccountOrders(this.themeContext(req, reply), {
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
          countryCode: 'TW',
          recipient: body.recipient ?? '',
          phone: body.addressPhone ?? '',
          postcode: body.postcode ?? '',
          city: body.city ?? '',
          district: body.district?.trim() || null,
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
    this.html(reply, 200, this.theme.renderAccountProfile(this.themeContext(req, reply), {
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
      const [refunds, rmas, latestAttempt, shipment, invoice] = await Promise.all([
        this.runtime.queries.execute<{ items: any[] }>('commerce.refund.listRefunds', { orderId: order.id, limit: 20, offset: 0 }, { actor, channel: 'rest' }),
        this.runtime.queries.execute<{ items: any[] }>('commerce.rma.listRmas', { orderId: order.id, limit: 100, offset: 0 }, { actor, channel: 'rest' }),
        Promise.resolve(order.paymentAttempts.at(-1) ?? null),
        // `getOrder` above has already returned only this customer's order. The
        // shipment query runs as system because customer RBAC deliberately does
        // not grant an unscoped shipment-read capability.
        this.runtime.queries.execute<any>('commerce.shipping.getShipmentForOrder', { orderId: order.id }, { actor: SYSTEM_ACTOR, channel: 'rest' })
          .catch((error: unknown) => error instanceof PlatformError && error.code === 'NOT_FOUND' ? null : Promise.reject(error)),
        // getOrder above has already enforced ownership. Expose only the
        // customer-safe status and number from the protected invoice record.
        this.runtime.queries.execute<{ items: any[] }>('commerce.invoice.list', { orderId: order.id, limit: 1, offset: 0 }, { actor: SYSTEM_ACTOR, channel: 'rest' })
          .then((result) => result.items[0] ?? null),
      ]);
      const canContinuePayment = (order.status === 'payment_processing' && latestAttempt?.status === 'submitted')
        || (order.status === 'awaiting_payment' && latestAttempt?.status === 'awaiting_payment');
      const canShowInstructions = order.status === 'awaiting_payment' && latestAttempt?.status === 'awaiting_payment';
      const retryProvider = order.status === 'pending'
        ? this.runtime.providers.get<PaymentProvider>('payment')
        : null;
      this.html(reply, 200, this.theme.renderOrder(this.themeContext(req, reply), {
        order: {
          number: order.number,
          status: order.status,
          currency: order.currency,
          totalCents: order.totalCents,
          customerEmail: order.customerEmail,
          lines: order.lines.map((line: any) => ({
            id: line.id, sku: line.sku, name: line.name, quantity: line.quantity, lineTotalCents: line.lineTotalCents,
          })),
          payment: latestAttempt ? {
            status: latestAttempt.status,
            method: latestAttempt.method,
            // Do not carry an action or instructions from a failed/stale
            // attempt into customer HTML. The active order state is the gate.
            action: canContinuePayment ? latestAttempt.action : null,
            instructions: canShowInstructions ? latestAttempt.instructions : null,
            expiresAt: canShowInstructions ? latestAttempt.expiresAt : null,
          } : null,
          paymentRetry: retryProvider && retryProvider.paymentMethods().length > 0 ? {
            provider: retryProvider.id,
            methods: retryProvider.paymentMethods().map((method) => ({
              code: method.code,
              label: method.label,
              timing: method.timing,
            })),
          } : null,
          invoice: invoice ? { status: invoice.status, invoiceNumber: invoice.invoiceNumber } : null,
          // The command also checks for a shipment under the Order lock. The
          // page can only use the status projection and never bypasses it.
          canCancel: order.status === 'pending',
          delivery: order.delivery ? {
            shippingMethodName: order.delivery.shippingMethodName,
            destination: order.delivery.destination,
          } : null,
          shipment: shipment ? {
            status: shipment.status,
            trackingNumber: shipment.trackingNumber,
            trackingUrl: shipment.trackingUrl,
          } : null,
          refunds: refunds.items.map((refund) => ({
            amountCents: refund.amountCents, status: refund.status, requestedAt: refund.requestedAt, completedAt: refund.completedAt,
          })),
          canRequestRma: order.status === 'paid' && Boolean(shipment && shipment.status !== 'created'),
          rmas: rmas.items.map((rma) => ({
            status: rma.status, reason: rma.reason, staffNote: rma.staffNote, createdAt: rma.createdAt,
            lines: rma.lines.map((line: any) => ({ name: line.name, quantity: line.quantity })),
          })),
        },
      }));
    } catch (err) {
      this.renderError(reply, err, req);
    }
  }

  @Post('orders/:number/rmas')
  async createRma(
    @Req() req: AuthenticatedRequest,
    @Param('number') number: string,
    @Body() body: Record<string, unknown>,
    @Res() reply: FastifyReply,
  ) {
    const actor = actorOf(req);
    if (actor.type !== 'customer') {
      void reply.status(303).header('location', `/login?next=${encodeURIComponent(`/orders/${number}`)}`).send();
      return;
    }
    try {
      // Resolve through the customer-scoped query before command dispatch so a
      // guessed order number is indistinguishable from a missing one.
      const order = await this.runtime.queries.execute<{ id: string; number: string }>(
        'commerce.order.getOrder', { number }, { actor, channel: 'rest' },
      );
      await this.runtime.commands.execute('commerce.rma.createRma', {
        orderId: order.id,
        reason: typeof body.reason === 'string' ? body.reason : '',
        lines: rmaLinesFromForm(body),
      }, { actor, idempotencyKey: `storefront-rma:${order.id}:${randomUUID()}`, correlationId: randomUUID(), channel: 'rest' });
      void reply.status(303).header('location', `/orders/${order.number}`).send();
    } catch (err) {
      this.renderError(reply, err, req);
    }
  }

  @Post('orders/:number/pay')
  async retryPayment(
    @Req() req: AuthenticatedRequest,
    @Param('number') number: string,
    @Body() body: Record<string, string>,
    @Res() reply: FastifyReply,
  ) {
    const actor = actorOf(req);
    if (actor.type !== 'customer') {
      void reply.status(303).header('location', `/login?next=${encodeURIComponent(`/orders/${number}`)}`).send();
      return;
    }
    try {
      // Fetch through the scoped query before issuing a write: another
      // customer's number stays indistinguishable from a missing order.
      const order = await this.runtime.queries.execute<{ id: string; number: string }>(
        'commerce.order.getOrder', { number }, { actor, channel: 'rest' },
      );
      const provider = this.runtime.providers.get<PaymentProvider>('payment', body.paymentProvider || undefined);
      const method = provider.paymentMethods().find((candidate) => candidate.code === body.paymentMethod);
      if (!method) throw PlatformError.validation('請先選擇可用的付款方式');
      await this.runtime.commands.execute('commerce.order.payOrder', {
        orderId: order.id,
        provider: provider.id,
        method: method.code,
      }, {
        actor,
        // Distinct browser submissions are safe: payOrder serializes on Order
        // and creates at most one active attempt.
        idempotencyKey: `storefront-pay:${order.id}:${randomUUID()}`,
        correlationId: randomUUID(),
        channel: 'rest',
      });
      void reply.status(303).header('location', `/orders/${order.number}`).send();
    } catch (err) {
      this.renderError(reply, err, req);
    }
  }

  @Post('orders/:number/cancel')
  async cancelOrder(
    @Req() req: AuthenticatedRequest,
    @Param('number') number: string,
    @Res() reply: FastifyReply,
  ) {
    const actor = actorOf(req);
    if (actor.type !== 'customer') {
      void reply.status(303).header('location', `/login?next=${encodeURIComponent(`/orders/${number}`)}`).send();
      return;
    }
    try {
      const order = await this.runtime.queries.execute<{ id: string; number: string }>(
        'commerce.order.getOrder', { number }, { actor, channel: 'rest' },
      );
      await this.runtime.commands.execute('commerce.order.cancelOrder', {
        orderId: order.id,
        reason: 'customer request',
      }, {
        actor,
        idempotencyKey: `storefront-cancel:${order.id}:${randomUUID()}`,
        correlationId: randomUUID(),
        channel: 'rest',
      });
      void reply.status(303).header('location', `/orders/${order.number}`).send();
    } catch (err) {
      this.renderError(reply, err, req);
    }
  }

  @Get('cart')
  async cart(@Req() req: AuthenticatedRequest, @Res() reply: FastifyReply) {
    try {
      this.html(reply, 200, this.theme.renderCart(this.themeContext(req, reply), await this.cartView(req, reply)));
    } catch (err) {
      this.renderError(reply, err, req);
    }
  }

  @Post('cart/items')
  async addToCart(
    @Req() req: AuthenticatedRequest,
    @Body() body: Record<string, string>,
    @Res() reply: FastifyReply,
  ) {
    await this.cartCommand(req, reply, 'commerce.cart.addToCart', {
      productId: body.productId,
      quantity: Number.parseInt(body.quantity ?? '1', 10),
    });
  }

  /** 數量設成 0 就是移除——前台的數量欄位本來就會走到 0，讓它自然表達「不要了」。 */
  @Post('cart/items/:productId')
  async setCartItemQuantity(
    @Req() req: AuthenticatedRequest,
    @Param('productId') productId: string,
    @Body() body: Record<string, string>,
    @Res() reply: FastifyReply,
  ) {
    await this.cartCommand(req, reply, 'commerce.cart.setCartItemQuantity', {
      productId,
      quantity: Number.parseInt(body.quantity ?? '0', 10),
    });
  }

  /** 清空購物車。Spec 0003 User Story 5，也是顧客卡住時唯一的自救手段。 */
  @Post('cart/clear')
  async clearCart(@Req() req: AuthenticatedRequest, @Res() reply: FastifyReply) {
    await this.cartCommand(req, reply, 'commerce.cart.clearCart', {});
  }

  /** 折扣碼：套用或移除。這條路由與 REST 端點同樣受節流保護（掃碼機器人）。 */
  @Post('cart/coupon')
  async cartCoupon(
    @Req() req: AuthenticatedRequest,
    @Body() body: Record<string, string>,
    @Res() reply: FastifyReply,
  ) {
    if (body.remove) {
      await this.cartCommand(req, reply, 'commerce.cart.removeCoupon', {});
      return;
    }
    // 無效的碼不是錯誤頁：把原因留在購物車頁上，顧客才改得了。
    try {
      await this.runtime.commands.execute('commerce.cart.applyCoupon', {
        code: (body.code ?? '').trim(),
        guestToken: guestTokenFor(req, reply, this.runtime.config.http.publicUrl),
      }, { actor: actorOf(req), idempotencyKey: randomUUID(), channel: 'rest' });
      void reply.status(303).header('location', '/cart').send();
    } catch (err) {
      const message = err instanceof PlatformError && err.httpStatus < 500 ? err.message : '這組折扣碼無法使用。';
      this.html(reply, 400, this.theme.renderCart(this.themeContext(req, reply), {
        ...await this.cartView(req, reply),
        couponError: message,
      }));
    }
  }

  /** 購物金的來源說法在這裡翻成中文：Theme 不該認得 `order-accrual` 這種字串。 */
  @Get('account/rewards')
  async accountRewards(@Req() req: AuthenticatedRequest, @Res() reply: FastifyReply) {
    const actor = actorOf(req);
    if (actor.type !== 'customer') {
      void reply.status(303).header('location', `/login?next=${encodeURIComponent('/account/rewards')}`).send();
      return;
    }
    try {
      const [rewards, tier] = await Promise.all([
        this.runtime.queries.execute<any>('commerce.loyalty.getMyRewards', {}, { actor, channel: 'rest' }),
        this.runtime.queries.execute<any>('commerce.loyalty.getMyTier', {}, { actor, channel: 'rest' }),
      ]);

      this.html(reply, 200, this.theme.renderAccountRewards(this.themeContext(req, reply), {
        currency: this.runtime.config.store.currency,
        balance: rewards.balance,
        entries: rewards.entries.map((entry: any) => ({
          amountCents: entry.amountCents,
          description: rewardDescription(entry),
          effectiveAt: entry.effectiveAt,
          expiresAt: entry.expiresAt,
          createdAt: entry.createdAt,
        })),
        tier: {
          name: tier.current.name,
          points: tier.points,
          next: tier.next ? { name: tier.next.tier.name, remainingPoints: tier.next.remainingPoints } : null,
          windowStartsAt: tier.windowStartsAt,
          windowMonths: tier.windowMonths,
        },
      }));
    } catch (err) {
      this.renderError(reply, err, req);
    }
  }

  @Get('account/coupons')
  async accountCoupons(@Req() req: AuthenticatedRequest, @Res() reply: FastifyReply) {
    const actor = actorOf(req);
    if (actor.type !== 'customer') {
      void reply.status(303).header('location', `/login?next=${encodeURIComponent('/account/coupons')}`).send();
      return;
    }
    try {
      const result = await this.runtime.queries.execute<{ items: any[] }>(
        'commerce.coupon.listMyCoupons', {}, { actor, channel: 'rest' },
      );
      this.html(reply, 200, this.theme.renderAccountCoupons(this.themeContext(req, reply), { coupons: result.items }));
    } catch (err) {
      this.renderError(reply, err, req);
    }
  }

  /**
   * 折抵多少購物金。輸入以「元」為單位——顧客看到的金額就是元，
   * 讓他在唯一一個會打字的地方改用「分」是自找的客訴。
   */
  @Post('cart/rewards')
  async cartRewards(
    @Req() req: AuthenticatedRequest,
    @Body() body: Record<string, string>,
    @Res() reply: FastifyReply,
  ) {
    const actor = actorOf(req);
    if (actor.type !== 'customer') {
      void reply.status(303).header('location', `/login?next=${encodeURIComponent('/cart')}`).send();
      return;
    }
    // 欄位是「元」而且允許小數：折抵額不見得是整數元（餘額或小計都可能不是），
    // 用整數元來回換算會讓每一次重送都少折幾分。
    const amount = Number(body.amount ?? '0');
    const amountCents = Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100)) : 0;
    await this.cartCommand(req, reply, 'commerce.cart.setRewardRedemption', { amountCents });
  }

  /** 確認頁。內容不能在這裡改，否則「確認的東西」與「結出來的單」會是兩份。 */
  @Get('checkout')
  async checkoutPage(
    @Query('shippingMethodId') requestedShippingMethodId: string | undefined,
    @Query('pickupSelectionToken') pickupSelectionToken: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ) {
    const actor = actorOf(req);
    if (actor.type !== 'customer') {
      void reply.status(303).header('location', `/login?next=${encodeURIComponent('/checkout')}`).send();
      return;
    }
    try {
      const [view, profile, methods] = await Promise.all([
        this.cartView(req, reply),
        this.runtime.queries.execute<any>('commerce.customer.getMyProfile', {}, { actor, channel: 'rest' }),
        this.runtime.queries.execute<{ items: any[] }>(
          'commerce.shipping.listShippingMethods', { enabled: true, limit: 100, offset: 0 }, { actor, channel: 'rest' },
        ),
      ]);
      if (view.lines.length === 0) {
        void reply.status(303).header('location', '/cart').send();
        return;
      }
      const shippingMethods = methods.items
        .map((method) => ({
          id: method.id,
          name: method.name,
          destinationKind: method.destinationKind,
          feeCents: method.feeCents,
          freeShippingThresholdCents: method.freeShippingThresholdCents,
        }));
      if (shippingMethods.length === 0) {
        throw PlatformError.validation('No shipping method is currently available');
      }
      const selectedShippingMethodId = requestedShippingMethodId || shippingMethods[0]!.id;
      if (!shippingMethods.some((method) => method.id === selectedShippingMethodId)) {
        throw PlatformError.validation('請選擇可用的配送方式');
      }
      // The selected fee comes from Shipping, not the form or its displayed
      // method data. `view` itself is also a fresh server-side cart projection.
      const shippingPreview = await this.runtime.queries.execute<{ shippingCents: number }>(
        'commerce.shipping.quoteCheckoutShipping',
        {
          shippingMethodId: selectedShippingMethodId,
          subtotalCents: view.subtotalCents,
          destinationKind: shippingMethods.find((method) => method.id === selectedShippingMethodId)!.destinationKind,
        },
        { actor, channel: 'rest' },
      );
      const provider = this.runtime.providers.get<PaymentProvider>('payment');
      const paymentMethods = provider.paymentMethods();
      if (paymentMethods.length === 0) {
        throw PlatformError.validation(`Payment provider ${provider.id} has no enabled payment methods`);
      }
      const buyer = await customerService.requireByActor(this.runtime.database.db, actor);
      const selection = pickupSelectionToken
        ? await this.runtime.queries.execute<any>('commerce.shipping.getPickupSelectionView', {
          token: pickupSelectionToken, cartId: view.cartId, customerId: buyer.customerId, shippingMethodId: selectedShippingMethodId,
        }, { actor, channel: 'rest' })
        : null;
      if (selection && !selection.store) throw PlatformError.validation('Please choose a convenience store before checkout');
      this.html(reply, 200, this.theme.renderCheckout(this.themeContext(req, reply), {
        ...view,
        customerEmail: await this.emailOf(actor),
        shippingMethods,
        selectedShippingMethodId,
        shippingPreview: {
          shippingCents: shippingPreview.shippingCents,
          totalCents: view.totalCents + shippingPreview.shippingCents,
        },
        deliveryAddress: profile.address ? {
          recipient: profile.address.recipient,
          phone: profile.address.phone,
          postcode: profile.address.postcode,
          city: profile.address.city,
          district: profile.address.district,
          line1: profile.address.line1,
          line2: profile.address.line2,
        } : null,
        pickupSelection: selection?.store ? { token: selection.token, storeName: selection.store.storeName, storeAddress: selection.store.storeAddress } : null,
        payment: {
          provider: provider.id,
          methods: paymentMethods.map((method) => ({ code: method.code, label: method.label, timing: method.timing })),
        },
        invoice: this.runtime.providers.has('invoice') ? { enabled: true } : undefined,
      }));
    } catch (err) {
      this.renderError(reply, err, req);
    }
  }

  @Post('checkout/pickup/start')
  async startPickupSelection(@Req() req: AuthenticatedRequest, @Body() body: Record<string, string>, @Res() reply: FastifyReply) {
    const actor = actorOf(req);
    if (actor.type !== 'customer') {
      void reply.status(303).header('location', `/login?next=${encodeURIComponent('/checkout')}`).send();
      return;
    }
    try {
      const selection = await this.runtime.commands.execute<{ token: string }>('commerce.shipping.beginPickupSelection', {
        cartId: body.cartId, shippingMethodId: body.shippingMethodId,
      }, { actor, correlationId: randomUUID(), channel: 'rest' });
      void reply.status(303).header('location', `/checkout/pickup/select?token=${encodeURIComponent(selection.token)}`).send();
    } catch (err) {
      this.renderError(reply, err, req);
    }
  }

  @Get('checkout/pickup/select')
  async pickupStorePicker(@Query('token') token: string, @Req() req: AuthenticatedRequest, @Res() reply: FastifyReply) {
    const actor = actorOf(req);
    if (actor.type !== 'customer') {
      void reply.status(303).header('location', `/login?next=${encodeURIComponent('/checkout')}`).send();
      return;
    }
    try {
      const view = await this.cartView(req, reply);
      const buyer = await customerService.requireByActor(this.runtime.database.db, actor);
      // The view establishes the token binding before calling a provider. A token
      // cannot turn into an oracle for another cart's method or carrier stores.
      const selection = await this.runtime.queries.execute<any>('commerce.shipping.getPickupSelectionView', {
        token, cartId: view.cartId, customerId: buyer.customerId, shippingMethodId: undefined,
      }, { actor, channel: 'rest' });
      const provider = this.runtime.providers.get<ShippingProvider>('shipping', selection.provider);
      if (!provider.pickupStores) throw PlatformError.validation('This shipping provider does not have a store picker');
      this.html(reply, 200, this.theme.renderPickupStorePicker(this.themeContext(req, reply), {
        token, shippingMethodId: selection.shippingMethodId, expiresAt: selection.expiresAt,
        stores: [...await provider.pickupStores({ serviceType: selection.type })],
      }));
    } catch (err) {
      this.renderError(reply, err, req);
    }
  }

  /** The picker may return without a session cookie; the opaque capability is the sole authority. */
  @ExternalCallback()
  @Post('checkout/pickup/callback')
  async completePickupSelection(@Body() body: Record<string, string>, @Res() reply: FastifyReply) {
    try {
      await this.runtime.commands.execute('commerce.shipping.completePickupSelection', {
        token: body.token, providerStoreId: body.providerStoreId,
      }, { actor: this.runtime.actorForRole('storefront'), idempotencyKey: `pickup-callback:${createHash('sha256').update(`${body.token}:${body.providerStoreId}`).digest('base64url')}`, correlationId: randomUUID(), channel: 'rest' });
      void reply.status(303).header('location', `/checkout?pickupSelectionToken=${encodeURIComponent(body.token)}`).send();
    } catch (err) {
      this.renderError(reply, err);
    }
  }

  /**
   * 送出訂單並立即排入付款工作，訂單頁呈現處理中的狀態。
   *
   * 冪等鍵是購物車識別碼，而它由表單帶回來：重送的請求若改問「現在的車」
   * 會問到一台新的空車。這是 Spec 0003 點名要修的缺陷——原本每次現產一個
   * 隨機值，等於完全沒有保護。
   */
  @Post('checkout')
  async checkout(@Req() req: AuthenticatedRequest, @Body() body: Record<string, string>, @Res() reply: FastifyReply) {
    const actor = actorOf(req);
    // 結帳需要身分。未登入不是錯誤，是「先去登入，然後回到這裡」。
    if (actor.type !== 'customer') {
      void reply.status(303).header('location', `/login?next=${encodeURIComponent('/checkout')}`).send();
      return;
    }
    try {
      const cartId = body.cartId;
      const correlationId = randomUUID();
      const paymentProvider = this.runtime.providers.get<PaymentProvider>('payment', body.paymentProvider || undefined);
      const paymentMethod = paymentProvider.paymentMethods().find((method) => method.code === body.paymentMethod);
      if (!paymentMethod) {
        throw PlatformError.validation('請先選擇可用的付款方式');
      }
      const order = await this.runtime.commands.execute<{ id: string; number: string }>(
        'commerce.order.checkoutCart',
        {
          cartId,
          shippingMethodId: body.shippingMethodId,
          ...(body.pickupSelectionToken ? {
            pickupSelectionToken: body.pickupSelectionToken, pickupRecipient: body.pickupRecipient?.trim() ?? '', pickupPhone: body.pickupPhone?.trim() ?? '',
          } : { destination: {
            kind: 'taiwan_home', countryCode: 'TW', recipient: body.recipient?.trim() ?? '', phone: body.phone?.trim() ?? '',
            postcode: body.postcode?.trim() ?? '', city: body.city?.trim() ?? '', district: body.district?.trim() ?? '',
            line1: body.line1?.trim() ?? '', line2: body.line2?.trim() || null,
          } }),
          invoicePreference: invoicePreferenceFromForm(body),
        },
        // 鍵綁上身分：冪等鍵是猜得到的（購物車識別碼），而它決定了誰讀得到那份回應。
        { actor, idempotencyKey: `cart:${actor.id}:${cartId}`, correlationId, channel: 'rest' },
      );
      await this.runtime.commands.execute('commerce.order.payOrder', {
        orderId: order.id,
        provider: paymentProvider.id,
        method: paymentMethod.code,
      }, {
        // `payOrder` locks the aggregate and refuses a second active attempt. This key is
        // deliberately per submission so a failed attempt can be retried from the order flow.
        actor, idempotencyKey: `storefront-pay:${order.id}:${randomUUID()}`, correlationId, channel: 'rest',
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
  async login(
    @Req() req: AuthenticatedRequest,
    @Body() body: Record<string, string>,
    @Res() reply: FastifyReply,
  ) {
    const next = safeNext(body.next);
    try {
      const session = await this.runtime.auth.authenticate(this.runtime.database.db, {
        email: body.email,
        password: body.password,
      });
      await startSession(this.runtime, req, reply, session);
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
  async register(
    @Req() req: AuthenticatedRequest,
    @Body() body: Record<string, string>,
    @Res() reply: FastifyReply,
  ) {
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
      await startSession(this.runtime, req, reply, session);
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
    const token = sessionTokenOf(req, this.runtime.config.http.publicUrl);
    if (token) await this.runtime.auth.revokeSession(this.runtime.database.db, token);
    clearSessionCookies(reply as never, this.runtime.config.http.publicUrl);
    void reply.status(303).header('location', '/').send();
  }

  /** 購物車頁與確認頁看的是同一份資料，差別只在能不能改。 */
  private async cartView(req: AuthenticatedRequest, reply: FastifyReply) {
    // 讀取不簽發 token：沒有車就是空車，而不是發一張新的把舊的蓋掉。
    const cart = await this.runtime.queries.execute<any>(
      'commerce.cart.getCart',
      { guestToken: existingGuestToken(req, this.runtime.config.http.publicUrl) },
      { actor: actorOf(req), channel: 'rest' },
    );
    return {
      cartId: cart.id,
      currency: cart.currency,
      lines: cart.items,
      subtotalCents: cart.subtotalCents,
      discountCents: cart.discountCents,
      totalCents: cart.totalCents,
      adjustments: cart.adjustments,
      nextThreshold: cart.nextThreshold,
      coupon: cart.coupon,
      couponError: cart.couponError,
      reward: cart.reward,
      removedNames: cart.removedNames,
    };
  }

  /** 購物車的寫入一律回到 /cart：POST 之後轉址，重新整理才不會再送一次。 */
  private async cartCommand(
    req: AuthenticatedRequest,
    reply: FastifyReply,
    name: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    try {
      const guestToken = guestTokenFor(req, reply, this.runtime.config.http.publicUrl);
      await this.runtime.commands.execute(name, {
        ...input,
        // 會員沒有 guestToken；有些購物車命令是 strict 的，多送一個欄位會被擋下。
        ...(guestToken ? { guestToken } : {}),
      }, { actor: actorOf(req), idempotencyKey: randomUUID(), correlationId: randomUUID(), channel: 'rest' });
      void reply.status(303).header('location', '/cart').send();
    } catch (err) {
      this.renderError(reply, err, req);
    }
  }

  private async emailOf(actor: Actor): Promise<string> {
    const profile = await this.runtime.queries.execute<{ email: string }>(
      'commerce.customer.getMyProfile', {}, { actor, channel: 'rest' },
    );
    return profile.email;
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
    this.html(reply, status, this.theme.renderError(this.themeContext(req, reply), { status, message }));
  }
}

function invoicePreferenceFromForm(body: Record<string, string>) {
  switch (body.invoicePreference) {
    case 'mobile': return { kind: 'mobile' as const, number: body.invoiceCarrierNumber?.trim() ?? '' };
    case 'natural_person': return { kind: 'natural_person' as const, number: body.invoiceCarrierNumber?.trim() ?? '' };
    case 'donation': return { kind: 'donation' as const, loveCode: body.invoiceLoveCode?.trim() ?? '' };
    default: return { kind: 'ecpay' as const };
  }
}
