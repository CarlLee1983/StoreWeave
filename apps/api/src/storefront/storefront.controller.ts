import type { CommerceConfig } from '@storeweave/config';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PlatformError, SYSTEM_ACTOR, type Actor } from '@storeweave/contracts';
import { csrfTokenFor } from '@storeweave/identity';
import type { StorefrontTheme, ThemeContext } from '@storeweave/kernel';
import type { PaymentProvider, ShippingProvider } from '@storeweave/extension-sdk';
import { customerService } from '@storeweave/customer';
import { Anonymous, ExternalCallback, Public, actorOf, anonymousActor, type AuthenticatedRequest } from '../http/auth';
import { clearSessionCookies, sessionTokenOf } from '../http/session-cookies';
import { cartNoticeOf, clearCartNoticeCookie, existingGuestToken, guestTokenFor } from '../http/cart-cookie';
import { HTTP_ADAPTER, type ReleaseHttpAdapter } from '../release-adapter';
import { HttpContract } from '../http/contract';
import { buildThemeContext, renderStorefrontError } from './storefront-context';
import { resolveThemeAssetsDir } from '../theme-assets';
import { RELEASE, RUNTIME, THEME, type ReleaseInfo, type Runtime } from '../tokens';
import { storefrontAssetContract, storefrontContracts, WOVEN_DAY_ARTWORK } from './storefront.contract';

const WOVEN_DAY_ARTWORK_SET = new Set<string>(WOVEN_DAY_ARTWORK);

/** 重設連結的時效。夠久到收得到信，短到外洩的信件不會長期有效。 */
const RESET_TTL_MS = 60 * 60 * 1000;
const CATALOG_PAGE_SIZE = 24;

/** Home only teases brand content; the dedicated pages carry the full list. */
const HOME_JOURNAL_COUNT = 2;
const HOME_NEWS_COUNT = 3;
/** One address may land this many messages per window before it is quietly dropped. */
const CONTACT_WINDOW_MS = 10 * 60 * 1000;
const CONTACT_WINDOW_LIMIT = 10;

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

/**
 * 預設 Storefront：NestJS SSR，畫面完全由 Theme 決定。
 * 這裡同樣只呼叫 Command / Query Bus。
 */
@Public()
@Controller()
export class StorefrontController {
  constructor(
    @Inject(RUNTIME) private readonly runtime: Runtime<CommerceConfig>,
    @Inject(THEME) private readonly theme: StorefrontTheme,
    @Inject(RELEASE) private readonly release: ReleaseInfo,
    @Inject(HTTP_ADAPTER) private readonly http: ReleaseHttpAdapter,
  ) {}

  /** Sliding contact-form windows keyed by address; in-process, never persisted. */
  private readonly contactAttempts = new Map<string, number[]>();

  /**
   * SSR pages may refer to theme-owned editorial media before a development
   * watcher has rebuilt its release descriptor. Keep this narrow fallback in
   * the storefront boundary; it never exposes merchant-uploaded product media.
   */
  @HttpContract(storefrontAssetContract)
  @Get('storefront-assets/:file')
  themeArtwork(@Param('file') file: string, @Res() reply: FastifyReply) {
    if (!WOVEN_DAY_ARTWORK_SET.has(file)) {
      return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    }

    const assetRoot = resolveThemeAssetsDir({ configuredDir: this.release.themeAssetsDir });
    const path = assetRoot && join(assetRoot, file);
    if (!path || !existsSync(path)) {
      return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    }

    return reply.type('image/png').header('cache-control', 'public, max-age=0').send(readFileSync(path));
  }

  /** 與 generated controller 共用同一份組裝，兩邊不會各自長出一套語意。 */
  private get contextDeps() {
    return { runtime: this.runtime, theme: this.theme, anonymousRole: 'storefront' as const };
  }

  private themeContext(req?: AuthenticatedRequest, reply?: FastifyReply): Promise<ThemeContext> {
    return buildThemeContext(this.contextDeps, req, reply);
  }

  private html(reply: FastifyReply, status: number, body: string) {
    void reply.status(status).header('content-type', 'text/html; charset=utf-8').send(body);
  }

  /** The picker may return without a session cookie; the opaque capability is the sole authority. */
  @ExternalCallback()
  @HttpContract(storefrontContracts.completePickupSelection)
  @Post('checkout/pickup/callback')
  async completePickupSelection(@Body() body: Record<string, string>, @Res() reply: FastifyReply) {
    try {
      await this.runtime.commands.execute('commerce.shipping.completePickupSelection', {
        token: body.token, providerStoreId: body.providerStoreId,
      }, { actor: this.runtime.actorForRole('storefront'), idempotencyKey: `pickup-callback:${createHash('sha256').update(`${body.token}:${body.providerStoreId}`).digest('base64url')}`, correlationId: randomUUID(), channel: 'rest' });
      void reply.status(303).header('location', `/checkout?pickupSelectionToken=${encodeURIComponent(body.token)}`).send();
    } catch (err) {
      await this.renderError(reply, err);
    }
  }

  @Anonymous()
  @HttpContract(storefrontContracts.forgotPasswordPage)
  @Get('forgot-password')
  async forgotPasswordPage(@Res() reply: FastifyReply) {
    this.html(reply, 200, this.renderTheme('platform.auth', await this.themeContext(), { mode: 'forgot-password', next: '/' }));
  }

  @Anonymous()
  @HttpContract(storefrontContracts.forgotPassword)
  @Post('forgot-password')
  async forgotPassword(@Body() body: Record<string, string>, @Res() reply: FastifyReply) {
    // 回應一律中性：區分「寄了」與「沒這個帳號」等於送出帳號枚舉管道。
    const neutral = '若這個電子郵件存在，我們已經把重設連結寄出去了。';
    try {
      // 簽發、加密暫存與寄信都在 identity 的同一個交易裡完成（B08）。
      await this.runtime.auth.requestPasswordReset({ email: body.email ?? '', ttlMs: RESET_TTL_MS });
    } catch (err) {
      // 寄信失敗也不改變對外的訊息，只留在 log 裡——否則它就是那條枚舉管道。
      this.runtime.logger.error({ error: (err as Error).message }, 'password reset delivery failed');
    }
    this.html(reply, 200, this.renderTheme('platform.auth', await this.themeContext(), {
      mode: 'forgot-password', next: '/', notice: neutral,
    }));
  }

  @Anonymous()
  @HttpContract(storefrontContracts.resetPasswordPage)
  @Get('reset-password')
  async resetPasswordPage(@Query('token') token: string | undefined, @Res() reply: FastifyReply) {
    this.html(reply, 200, this.renderTheme('platform.auth', await this.themeContext(), {
      mode: 'reset-password', next: '/', token: token ?? '',
    }));
  }

  @Anonymous()
  @HttpContract(storefrontContracts.resetPassword)
  @Post('reset-password')
  async resetPassword(@Body() body: Record<string, string>, @Res() reply: FastifyReply) {
    try {
      await this.runtime.auth.resetPassword({ token: body.token ?? '', newPassword: body.password ?? '' });
      void reply.status(303).header('location', '/login').send();
    } catch (err) {
      const message = err instanceof PlatformError && err.httpStatus < 500 ? err.message : '設定新密碼失敗，請重新申請一次。';
      this.html(reply, 400, this.renderTheme('platform.auth', await this.themeContext(), {
        mode: 'reset-password', next: '/', token: body.token ?? '', error: message,
      }));
    }
  }

  @Anonymous()
  @HttpContract(storefrontContracts.loginPage)
  @Get('login')
  async loginPage(@Query('next') next: string | undefined, @Res() reply: FastifyReply) {
    this.html(reply, 200, this.renderTheme('platform.auth', await this.themeContext(), { mode: 'login', next: safeNext(next) }));
  }

  @Anonymous()
  @HttpContract(storefrontContracts.registerPage)
  @Get('register')
  async registerPage(@Query('next') next: string | undefined, @Res() reply: FastifyReply) {
    this.html(reply, 200, this.renderTheme('platform.auth', await this.themeContext(), { mode: 'register', next: safeNext(next) }));
  }

  @Anonymous()
  @HttpContract(storefrontContracts.login)
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
      await this.http.startSession(this.runtime, req, reply, session);
      void reply.status(303).header('location', next).send();
    } catch {
      // 訊息一律中性：區分「沒這個帳號」與「密碼錯」等於送出帳號枚舉管道。
      this.html(reply, 401, this.renderTheme('platform.auth', await this.themeContext(), {
        mode: 'login', next, error: '電子郵件或密碼不正確。',
      }));
    }
  }

  @Anonymous()
  @HttpContract(storefrontContracts.register)
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
      }, { actor: anonymousActor(this.runtime, 'storefront'), channel: 'rest' });

      // 註冊完直接登入：讓人再打一次同一組密碼沒有任何意義。
      const session = await this.runtime.auth.authenticate(this.runtime.database.db, {
        email: body.email,
        password: body.password,
      });
      await this.http.startSession(this.runtime, req, reply, session);
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
      this.html(reply, 400, this.renderTheme('platform.auth', await this.themeContext(), { mode: 'register', next, error: message }));
    }
  }

  // 強制匿名：HTML 表單送不出 CSRF header，而被強制登出是干擾而不是資料外洩。
  @Anonymous()
  @HttpContract(storefrontContracts.logout)
  @Post('logout')
  async logout(@Req() req: AuthenticatedRequest, @Res() reply: FastifyReply) {
    const token = sessionTokenOf(req, this.runtime.config.http.publicUrl);
    if (token) await this.runtime.auth.revokeSession(this.runtime.database.db, token);
    clearSessionCookies(reply as never, this.runtime.config.http.publicUrl);
    void reply.status(303).header('location', '/').send();
  }

  /**
   * Theme 是一份 page id → renderer 的對映（ADR 0045）。缺頁在啟動時就被擋下，
   * 走到這裡還缺就是註冊表與 Theme 不同步，讓它明確失敗而不是回半頁 HTML。
   */
  private renderTheme(id: string, ctx: ThemeContext, view: unknown): string {
    const render = this.theme.renderers[id];
    if (!render) throw PlatformError.validation(`Theme '${this.theme.id}' 沒有頁面 '${id}' 的 renderer`);
    return render(ctx, view);
  }

  private renderError(reply: FastifyReply, err: unknown, req?: AuthenticatedRequest): Promise<void> {
    return renderStorefrontError(this.contextDeps, reply, err, req);
  }
}

