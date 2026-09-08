import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { BusController } from './base';
import { ok } from '../http/envelope';
import { busHttpInput, HttpContract, type BusHttpContract, type ComposedHttpContract } from '../http/contract';
import type { AuthenticatedRequest } from '../http/auth';
import type { StorefrontTheme } from '@storeweave/kernel';
import { RUNTIME, THEME, type Runtime } from '../tokens';

const articleRoutes = {
  list: { kind: 'bus', target: { kind: 'query', name: 'commerce.content.listArticles' }, request: 'query' },
  get: { kind: 'bus', target: { kind: 'query', name: 'commerce.content.getArticle' }, request: 'none', params: { id: 'id' } },
  create: { kind: 'bus', target: { kind: 'command', name: 'commerce.content.createArticle' }, request: 'body' },
  update: { kind: 'bus', target: { kind: 'command', name: 'commerce.content.updateArticle' }, request: 'body', params: { id: 'id' } },
  publish: { kind: 'bus', target: { kind: 'command', name: 'commerce.content.publishArticle' }, request: 'none', params: { id: 'id' } },
  unpublish: { kind: 'bus', target: { kind: 'command', name: 'commerce.content.unpublishArticle' }, request: 'none', params: { id: 'id' } },
  remove: { kind: 'bus', target: { kind: 'command', name: 'commerce.content.deleteArticle' }, request: 'none', params: { id: 'id' } },
} as const satisfies Record<string, BusHttpContract>;

const imageKeysRoute = {
  kind: 'composed', target: { kind: 'query', name: 'commerce.content.listArticles' }, request: 'none', injected: ['limit'],
  output: { type: 'object', required: ['keys'], properties: { keys: { type: 'array', items: { type: 'string' } } } },
} satisfies ComposedHttpContract;

const contactRoutes = {
  list: { kind: 'bus', target: { kind: 'query', name: 'commerce.content.listContactMessages' }, request: 'query' },
  get: { kind: 'bus', target: { kind: 'query', name: 'commerce.content.getContactMessage' }, request: 'none', params: { id: 'id' } },
  markHandled: { kind: 'bus', target: { kind: 'command', name: 'commerce.content.markContactMessageHandled' }, request: 'none', params: { id: 'id' } },
} as const satisfies Record<string, BusHttpContract>;

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
  @HttpContract(imageKeysRoute)
  async imageKeys(@Req() req: AuthenticatedRequest) {
    // The list itself is theme-static, but this route sits behind the same gate
    // as its siblings: an unauthenticated caller must not learn more here than there.
    await this.query(req, imageKeysRoute.target.name, busHttpInput(imageKeysRoute, {}, {}, { limit: 1 }));
    return ok({ keys: this.theme.editorialImageKeys ?? [] });
  }

  @Get()
  @HttpContract(articleRoutes.list)
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, articleRoutes.list, query);
  }

  @Get(':id')
  @HttpContract(articleRoutes.get)
  async get(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, articleRoutes.get, {}, params);
  }

  @Post()
  @HttpCode(200)
  @HttpContract(articleRoutes.create)
  async create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.rest(req, articleRoutes.create, body);
  }

  @Post(':id')
  @HttpCode(200)
  @HttpContract(articleRoutes.update)
  async update(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.rest(req, articleRoutes.update, body, params);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @HttpContract(articleRoutes.publish)
  async publish(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, articleRoutes.publish, {}, params);
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  @HttpContract(articleRoutes.unpublish)
  async unpublish(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, articleRoutes.unpublish, {}, params);
  }

  @Delete(':id')
  @HttpCode(200)
  @HttpContract(articleRoutes.remove)
  async remove(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, articleRoutes.remove, {}, params);
  }
}

/** The inbox: staff read and close messages; sending stays on the storefront form. */
@Controller('api/v1/content/contact-messages')
export class ContentContactController extends BusController {
  @Get()
  @HttpContract(contactRoutes.list)
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, contactRoutes.list, query);
  }

  @Get(':id')
  @HttpContract(contactRoutes.get)
  async get(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, contactRoutes.get, {}, params);
  }

  @Post(':id/handled')
  @HttpCode(200)
  @HttpContract(contactRoutes.markHandled)
  async markHandled(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, contactRoutes.markHandled, {}, params);
  }
}
