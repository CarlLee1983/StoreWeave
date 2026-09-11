import type { CommerceConfig } from '@storeweave/config';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Body, Controller, Get, Inject, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { StorefrontTheme } from '@storeweave/kernel';
import { ExternalCallback, Public, type AuthenticatedRequest } from '../http/auth';
import { HttpContract } from '../http/contract';
import { renderStorefrontError } from './storefront-context';
import { resolveThemeAssetsDir } from '../theme-assets';
import { RELEASE, RUNTIME, THEME, type ReleaseInfo, type Runtime } from '../tokens';
import { storefrontAssetContract, storefrontContracts, WOVEN_DAY_ARTWORK } from './storefront.contract';

const WOVEN_DAY_ARTWORK_SET = new Set<string>(WOVEN_DAY_ARTWORK);

/**
 * 前台裡沒有被模組宣告成頁面的那兩條路由：Theme 的靜態資產，以及物流商打回來的取貨
 * 回呼。其餘每一頁都由模組宣告並由生成的 controller 掛載（ADR 0045，工單 94-96）。
 */
@Public()
@Controller()
export class StorefrontController {
  constructor(
    @Inject(RUNTIME) private readonly runtime: Runtime<CommerceConfig>,
    @Inject(THEME) private readonly theme: StorefrontTheme,
    @Inject(RELEASE) private readonly release: ReleaseInfo,
  ) {}

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

  private renderError(reply: FastifyReply, err: unknown, req?: AuthenticatedRequest): Promise<void> {
    return renderStorefrontError(this.contextDeps, reply, err, req);
  }
}
