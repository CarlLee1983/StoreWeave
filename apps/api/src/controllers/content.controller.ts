import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PlatformError } from '@storeweave/contracts';
import { BusController } from './base';
import { ok } from '../http/envelope';
import { busHttpInput, HttpContract, type BusHttpContract, type ComposedHttpContract } from '../http/contract';
import { actorOf, Public, type AuthenticatedRequest } from '../http/auth';
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
  setMedia: { kind: 'bus', target: { kind: 'command', name: 'commerce.content.setArticleMedia' }, request: 'body', params: { id: 'id' } },
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

  @Post(':id/media')
  @HttpCode(200)
  @HttpContract(articleRoutes.setMedia)
  async setMedia(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: unknown) {
    return this.rest(req, articleRoutes.setMedia, body, params);
  }
}

const uuid = { type: 'string', format: 'uuid' } as const;
const publicPreviewRoute = { kind: 'direct', request: 'none', input: { type: 'object', required: ['id'], properties: { id: uuid }, additionalProperties: false }, output: 'binary' } as const;
const publicDiscoveryRoute = { kind: 'direct', request: 'none', input: { type: 'object', additionalProperties: false }, output: 'binary' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Never opens generic media: only a preview referenced by a published article is public. */
@Public()
@Controller('content/media')
export class ContentPublicMediaController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}

  @Get(':id/preview')
  @HttpContract(publicPreviewRoute)
  async preview(@Req() request: AuthenticatedRequest, @Res() reply: FastifyReply, @Param('id') id: string) {
    if (!UUID.test(id)) throw PlatformError.notFound('Published media', id);
    await this.runtime.queries.execute('commerce.content.getPublishedMedia', { mediaAssetId: id }, { actor: actorOf(request), channel: 'rest' });
    const opened = await this.runtime.media.openPreview(id);
    reply.header('content-type', opened.object.contentType);
    reply.header('content-length', String(opened.object.byteSize));
    reply.header('content-disposition', 'inline');
    reply.header('cache-control', 'public, max-age=300');
    (request as FastifyRequest).raw.once('close', () => opened.content.destroy());
    return reply.send(opened.content);
  }
}

type DiscoveryArticle = { kind: 'story' | 'journal' | 'news' | 'faq'; slug: string; title: string; summary: string; publishedAt: Date | string | null };
const xml = (value: string) => value.replace(/[<>&'\"]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[character]!);
const articlePath = (article: DiscoveryArticle) => article.kind === 'story' || article.kind === 'faq' ? `/${article.kind}` : `/${article.kind}/${encodeURIComponent(article.slug)}`;

/** Module-owned discovery documents. They execute only the published projection. */
@Public()
@Controller()
export class ContentDiscoveryController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}

  private async published(request: AuthenticatedRequest): Promise<DiscoveryArticle[]> {
    const first = await this.runtime.queries.execute<{ items: DiscoveryArticle[]; total: number }>(
      'commerce.content.listPublishedSiteContent', { limit: 100, offset: 0 }, { actor: actorOf(request), channel: 'rest' },
    );
    const items = [...first.items];
    for (let offset = items.length; offset < first.total; offset += 100) {
      const page = await this.runtime.queries.execute<{ items: DiscoveryArticle[] }>(
        'commerce.content.listPublishedSiteContent', { limit: 100, offset }, { actor: actorOf(request), channel: 'rest' },
      );
      items.push(...page.items);
    }
    return items;
  }

  @Get('robots.txt')
  @HttpContract(publicDiscoveryRoute)
  async robots(@Res() reply: FastifyReply) {
    reply.type('text/plain; charset=utf-8').header('cache-control', 'public, max-age=300');
    return reply.send(`User-agent: *\nAllow: /\nSitemap: ${this.runtime.config.http.publicUrl.replace(/\/+$/, '')}/sitemap.xml\n`);
  }

  @Get('sitemap.xml')
  @HttpContract(publicDiscoveryRoute)
  async sitemap(@Req() request: AuthenticatedRequest, @Res() reply: FastifyReply) {
    const origin = this.runtime.config.http.publicUrl.replace(/\/+$/, '');
    const urls = new Map<string, Date | string | null>([['/contact', null]]);
    for (const article of await this.published(request)) urls.set(articlePath(article), article.publishedAt);
    const body = [...urls].map(([path, modified]) => `<url><loc>${xml(`${origin}${path}`)}</loc>${modified ? `<lastmod>${new Date(modified).toISOString()}</lastmod>` : ''}</url>`).join('');
    reply.type('application/xml; charset=utf-8').header('cache-control', 'public, max-age=300');
    return reply.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`);
  }

  @Get('rss.xml')
  @HttpContract(publicDiscoveryRoute)
  async rss(@Req() request: AuthenticatedRequest, @Res() reply: FastifyReply) {
    const origin = this.runtime.config.http.publicUrl.replace(/\/+$/, '');
    const articles = (await this.published(request)).filter(article => article.kind === 'journal' || article.kind === 'news');
    const items = articles.map(article => { const link = `${origin}${articlePath(article)}`; return `<item><title>${xml(article.title)}</title><link>${xml(link)}</link><guid>${xml(link)}</guid><description>${xml(article.summary)}</description>${article.publishedAt ? `<pubDate>${new Date(article.publishedAt).toUTCString()}</pubDate>` : ''}</item>`; }).join('');
    reply.type('application/rss+xml; charset=utf-8').header('cache-control', 'public, max-age=300');
    return reply.send(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${xml(this.runtime.config.store.name)}</title><link>${xml(origin)}</link><description>${xml(this.runtime.config.store.name)}</description>${items}</channel></rss>`);
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
