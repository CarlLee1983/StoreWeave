import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { ok } from '../http/envelope';
import type { AuthenticatedRequest } from '../http/auth';
import type { StorefrontTheme } from '@storeweave/kernel';
import { RUNTIME, THEME, type Runtime } from '../tokens';

/** Brand content is staff-authored; the storefront reads it through its own published-only queries. */
@Controller('api/v1/content/articles')
export class ContentArticleController extends BusController {
  constructor(@Inject(RUNTIME) runtime: Runtime, @Inject(THEME) private readonly theme: StorefrontTheme) {
    super(runtime);
  }

  /**
   * The photo keys an article may name. They belong to the active theme, so the
   * admin picks from this list instead of typing a path (ADR 0034).
   */
  @Get('image-keys')
  async imageKeys(@Req() req: AuthenticatedRequest) {
    // The list itself is theme-static, but this route sits behind the same gate
    // as its siblings: an unauthenticated caller must not learn more here than there.
    await this.query(req, 'commerce.content.listArticles', { limit: 1 });
    return ok({ keys: this.theme.editorialImageKeys ?? [] });
  }

  @Get()
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return ok(await this.query(req, 'commerce.content.listArticles', {
      kind: query.kind, status: query.status, limit: query.limit, offset: query.offset,
    }));
  }

  @Get(':id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return ok(await this.query(req, 'commerce.content.getArticle', { id }));
  }

  @Post()
  @HttpCode(200)
  async create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return ok(await this.command(req, 'commerce.content.createArticle', body));
  }

  @Post(':id')
  @HttpCode(200)
  async update(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.content.updateArticle', { ...body, id }));
  }

  @Post(':id/publish')
  @HttpCode(200)
  async publish(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return ok(await this.command(req, 'commerce.content.publishArticle', { id }));
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  async unpublish(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return ok(await this.command(req, 'commerce.content.unpublishArticle', { id }));
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return ok(await this.command(req, 'commerce.content.deleteArticle', { id }));
  }
}

/** The inbox: staff read and close messages; sending stays on the storefront form. */
@Controller('api/v1/content/contact-messages')
export class ContentContactController extends BusController {
  @Get()
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return ok(await this.query(req, 'commerce.content.listContactMessages', {
      status: query.status, limit: query.limit, offset: query.offset,
    }));
  }

  @Get(':id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return ok(await this.query(req, 'commerce.content.getContactMessage', { id }));
  }

  @Post(':id/handled')
  @HttpCode(200)
  async markHandled(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return ok(await this.command(req, 'commerce.content.markContactMessageHandled', { id }));
  }
}
