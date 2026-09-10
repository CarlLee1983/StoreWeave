import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError } from '@storeweave/contracts';
import { definePage, type PageOutcome, type PageResolveContext, type StorefrontHttpContract } from '@storeweave/kernel';
import type { JsonSchema7Type } from 'zod-to-json-schema';

/** 一篇品牌內容在前台看得到的樣子。`heading` 只有品牌故事的章節會用到，其餘一律 null。 */
export interface ThemeArticleView {
  kind: 'story' | 'journal' | 'news' | 'faq';
  slug: string;
  title: string;
  summary: string;
  section: string;
  body: { heading: string | null; text: string }[];
  imageKey: string | null;
  publishedAt: Date | null;
}

export interface ThemeArticleListView {
  kind: ThemeArticleView['kind'];
  articles: ThemeArticleView[];
}

/**
 * 聯絡我們。送出成功後以 `submitted` 呈現結果頁，失敗則帶回填值與錯誤——
 * 這是標準表單 POST，沒有 JavaScript 也要說得清楚發生了什麼。
 */
export interface ThemeContactView {
  submitted: boolean;
  values: { name: string; email: string; subject: string; message: string };
  error?: string;
}

interface ArticleDtoShape {
  kind: ThemeArticleView['kind'];
  slug: string; title: string; summary: string; section: string;
  body: { heading: string | null; text: string }[];
  imageKey: string | null; publishedAt: string | Date | null;
}

export function toArticleView(article: ArticleDtoShape): ThemeArticleView {
  return {
    kind: article.kind, slug: article.slug, title: article.title, summary: article.summary,
    section: article.section, body: article.body ?? [], imageKey: article.imageKey,
    publishedAt: article.publishedAt ? new Date(article.publishedAt) : null,
  };
}

/** One address may land this many messages per window before it is quietly dropped. */
const CONTACT_WINDOW_MS = 10 * 60 * 1000;
const CONTACT_WINDOW_LIMIT = 10;

/**
 * In-process only, and deliberately so: the sender is never persisted, and a
 * restart forgetting the window is cheaper than storing what visitors did.
 */
const contactAttempts = new Map<string, number[]>();

function contactWindow(key: string): { times: number[] } {
  const now = Date.now();
  return { times: (contactAttempts.get(key) ?? []).filter(at => now - at < CONTACT_WINDOW_MS) };
}

function contactOverLimit(key: string): boolean {
  const { times } = contactWindow(key);
  if (times.length < CONTACT_WINDOW_LIMIT) return false;
  contactAttempts.set(key, times);
  return true;
}

function recordContactLanding(key: string): void {
  const now = Date.now();
  const { times } = contactWindow(key);
  contactAttempts.set(key, [...times, now]);
  if (contactAttempts.size > 5_000) {
    for (const [other, at] of contactAttempts) {
      if (!at.some(time => now - time < CONTACT_WINDOW_MS)) contactAttempts.delete(other);
    }
  }
}

/** Published-only by construction: the storefront never sees the staff queries. */
async function publishedArticles(
  ctx: PageResolveContext, kind: ThemeArticleView['kind'], limit: number,
): Promise<ThemeArticleView[]> {
  const result = await ctx.queries.execute<{ items: ArticleDtoShape[] }>(
    'commerce.content.listPublishedArticles', { kind, limit }, { actor: ctx.actor },
  );
  return result.items.map(toArticleView);
}

/** Content that has not been published is, for the storefront, not there at all. */
async function publishedArticle(
  ctx: PageResolveContext, kind: ThemeArticleView['kind'], slug: string,
): Promise<ThemeArticleView | null> {
  try {
    const article = await ctx.queries.execute<ArticleDtoShape>(
      'commerce.content.getPublishedArticle', { kind, slug }, { actor: ctx.actor },
    );
    return toArticleView(article);
  } catch (err) {
    if (err instanceof PlatformError && err.code === 'NOT_FOUND') return null;
    throw err;
  }
}

const jsonSchema = (fields: readonly string[]): JsonSchema7Type => ({
  type: 'object',
  properties: Object.fromEntries(fields.map(field => [field, { type: 'string' }])),
  additionalProperties: true,
} as JsonSchema7Type);

const html = (status: number | 'platform-error' = 200): StorefrontHttpContract['responses'][number] => (
  { kind: 'html', status, contentType: 'text/html; charset=utf-8', body: 'theme' }
);

const htmlOnly: StorefrontHttpContract['responses'] = [html(), html('platform-error')];

const articleListView = (kind: ThemeArticleView['kind']) => async (ctx: PageResolveContext) => {
  const articles = await publishedArticles(ctx, kind, 50);
  if (!articles.length) return { kind: 'not-found' as const };
  return { kind: 'view' as const, view: { kind, articles } };
};

const articlePageView = (kind: 'journal' | 'news') => async (ctx: PageResolveContext, { slug }: { slug: string }) => {
  const article = await publishedArticle(ctx, kind, slug);
  if (!article) return { kind: 'not-found' as const };
  return { kind: 'view' as const, view: { article } };
};

/**
 * 這段表單解析原封搬自 storefront controller：一個重複欄位會以陣列抵達，
 * JSON post 也可能在這裡放進物件，所以逐項驗形狀而不是信任呼叫端傳字串。
 */
const contactFieldsInput = z.object({
  name: z.unknown().optional(),
  email: z.unknown().optional(),
  subject: z.unknown().optional(),
  message: z.unknown().optional(),
  website: z.unknown().optional(),
}).transform(raw => {
  const field = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
  return {
    name: field(raw.name), email: field(raw.email),
    subject: field(raw.subject), message: field(raw.message), website: field(raw.website),
  };
});

export const contentPages = {
  story: definePage({
    id: 'commerce.content.story',
    path: '/story',
    method: 'get',
    audience: 'public',
    input: z.object({}),
    required: false,
    contract: {
      kind: 'storefront', request: 'none', input: jsonSchema([]),
      responses: htmlOnly, cookieEffects: ['cart-notice-consume'],
    },
    resolve: async ctx => {
      // At most one published story is expected; the first is the one the store means.
      const [article] = await publishedArticles(ctx, 'story', 1);
      if (!article) return { kind: 'not-found' };
      return { kind: 'view', view: { article } };
    },
  }),

  journal: definePage({
    id: 'commerce.content.journalList',
    path: '/journal',
    method: 'get',
    audience: 'public',
    input: z.object({}),
    required: false,
    contract: {
      kind: 'storefront', request: 'none', input: jsonSchema([]),
      responses: htmlOnly, cookieEffects: ['cart-notice-consume'],
    },
    resolve: articleListView('journal'),
  }),

  journalArticle: definePage({
    id: 'commerce.content.journalArticle',
    path: '/journal/:slug',
    method: 'get',
    audience: 'public',
    input: z.object({ slug: z.string() }),
    required: false,
    contract: {
      kind: 'storefront', request: 'none', input: jsonSchema(['slug']), params: { slug: 'slug' },
      responses: htmlOnly, cookieEffects: ['cart-notice-consume'],
    },
    resolve: articlePageView('journal'),
  }),

  news: definePage({
    id: 'commerce.content.newsList',
    path: '/news',
    method: 'get',
    audience: 'public',
    input: z.object({}),
    required: false,
    contract: {
      kind: 'storefront', request: 'none', input: jsonSchema([]),
      responses: htmlOnly, cookieEffects: ['cart-notice-consume'],
    },
    resolve: articleListView('news'),
  }),

  newsArticle: definePage({
    id: 'commerce.content.newsArticle',
    path: '/news/:slug',
    method: 'get',
    audience: 'public',
    input: z.object({ slug: z.string() }),
    required: false,
    contract: {
      kind: 'storefront', request: 'none', input: jsonSchema(['slug']), params: { slug: 'slug' },
      responses: htmlOnly, cookieEffects: ['cart-notice-consume'],
    },
    resolve: articlePageView('news'),
  }),

  faq: definePage({
    id: 'commerce.content.faq',
    path: '/faq',
    method: 'get',
    audience: 'public',
    input: z.object({}),
    required: false,
    contract: {
      kind: 'storefront', request: 'none', input: jsonSchema([]),
      responses: htmlOnly, cookieEffects: ['cart-notice-consume'],
    },
    resolve: articleListView('faq'),
  }),

  contact: definePage({
    id: 'commerce.content.contact',
    path: '/contact',
    method: 'get',
    audience: 'public',
    input: z.object({}),
    contract: {
      kind: 'storefront', request: 'none', input: jsonSchema([]),
      responses: [html(), html(404)], cookieEffects: ['cart-notice-consume'],
    },
    resolve: async () => ({
      kind: 'view',
      view: { submitted: false, values: { name: '', email: '', subject: '', message: '' } },
    }),
  }),

  submitContact: definePage({
    id: 'commerce.content.submitContact',
    path: '/contact',
    method: 'post',
    audience: 'public',
    input: contactFieldsInput,
    contract: {
      kind: 'storefront', request: 'form', input: jsonSchema(['name', 'email', 'subject', 'message', 'website']),
      responses: [html(), html(400), html(404)], cookieEffects: ['cart-notice-consume'],
    },
    resolve: async (ctx, { website, ...fields }): Promise<PageOutcome<ThemeContactView>> => {
      const blank = { name: '', email: '', subject: '', message: '' };
      // A bot that fills the hidden field gets the same success page as everyone
      // else. Telling it apart is exactly what it came for.
      if (website || contactOverLimit(ctx.clientKey)) {
        return { kind: 'view', view: { submitted: true, values: blank } };
      }
      try {
        await ctx.commands.execute('commerce.content.submitContactMessage', fields, {
          actor: ctx.actor, idempotencyKey: randomUUID(),
        });
      } catch (err) {
        const message = err instanceof PlatformError && err.httpStatus < 500
          ? err.message : '訊息送出失敗，請稍後再試一次。';
        return { kind: 'view', status: 400, view: { submitted: false, values: fields, error: message } };
      }
      // Counted only once a message actually lands, so a visitor who mistypes
      // their address several times is not silently swallowed on the next try.
      recordContactLanding(ctx.clientKey);
      return { kind: 'view', view: { submitted: true, values: blank } };
    },
  }),
} as const;

export type ContentPages = typeof contentPages;
