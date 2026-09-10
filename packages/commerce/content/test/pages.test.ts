import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '@storeweave/contracts';
import { PlatformError } from '@storeweave/contracts';
import type { PageResolveContext } from '@storeweave/kernel';
import { contentPages } from '../src/pages';

const anonymous: Actor = { id: 'anonymous', type: 'service', displayName: 'anonymous', permissions: [] };

const article = (over: Record<string, unknown> = {}) => ({
  kind: 'journal', slug: 'a-slug', title: '標題', summary: '摘要', section: '欄目',
  body: [{ heading: null, text: '內文' }], imageKey: null, publishedAt: '2026-01-01T00:00:00.000Z', ...over,
});

const ctxWith = (
  execute: PageResolveContext['queries']['execute'],
  commandExecute: PageResolveContext['commands']['execute'] = vi.fn(),
  actor: Actor = anonymous,
): PageResolveContext => ({
  queries: { execute },
  commands: { execute: commandExecute },
  actor,
  locale: 'zh-TW',
});

describe('故事頁', () => {
  it('有已發布的故事就渲染第一篇', async () => {
    const execute = vi.fn(async () => ({ items: [article({ kind: 'story' })] }));

    const outcome = await contentPages.story.resolve(ctxWith(execute as never), {});

    expect(execute).toHaveBeenCalledWith(
      'commerce.content.listPublishedArticles', { kind: 'story', limit: 1 }, { actor: anonymous },
    );
    expect(outcome).toEqual({ kind: 'view', view: { article: expect.objectContaining({ slug: 'a-slug' }) } });
  });

  it('沒有發布過故事就是 not-found', async () => {
    const execute = vi.fn(async () => ({ items: [] }));

    const outcome = await contentPages.story.resolve(ctxWith(execute as never), {});

    expect(outcome).toEqual({ kind: 'not-found' });
  });
});

describe('生活誌／消息／FAQ 列表頁', () => {
  it('列出已發布內容', async () => {
    const execute = vi.fn(async (_name: string, input: { kind: string; limit: number }) =>
      ({ items: [article({ kind: input.kind })] }));

    const outcome = await contentPages.journal.resolve(ctxWith(execute as never), {});

    expect(execute).toHaveBeenCalledWith(
      'commerce.content.listPublishedArticles', { kind: 'journal', limit: 50 }, { actor: anonymous },
    );
    expect(outcome).toMatchObject({ kind: 'view', view: { kind: 'journal', articles: [{ slug: 'a-slug' }] } });
  });

  it('news 列表沒有已發布內容就是 not-found', async () => {
    const execute = vi.fn(async () => ({ items: [] }));

    const outcome = await contentPages.news.resolve(ctxWith(execute as never), {});

    expect(outcome).toEqual({ kind: 'not-found' });
  });

  it('faq 列表沒有已發布內容就是 not-found', async () => {
    const execute = vi.fn(async () => ({ items: [] }));

    const outcome = await contentPages.faq.resolve(ctxWith(execute as never), {});

    expect(outcome).toEqual({ kind: 'not-found' });
  });
});

describe('生活誌／消息單篇文章', () => {
  it('查得到已發布文章就渲染', async () => {
    const execute = vi.fn(async () => article({ kind: 'journal' }));

    const outcome = await contentPages.journalArticle.resolve(ctxWith(execute as never), { slug: 'a-slug' });

    expect(execute).toHaveBeenCalledWith(
      'commerce.content.getPublishedArticle', { kind: 'journal', slug: 'a-slug' }, { actor: anonymous },
    );
    expect(outcome).toEqual({ kind: 'view', view: { article: expect.objectContaining({ slug: 'a-slug' }) } });
  });

  it('未發布或不存在的 slug 是 not-found', async () => {
    const execute = vi.fn(async () => { throw PlatformError.notFound('Article', 'missing'); });

    const outcome = await contentPages.journalArticle.resolve(ctxWith(execute as never), { slug: 'missing' });

    expect(outcome).toEqual({ kind: 'not-found' });
  });

  it('news 單篇文章同樣走 not-found', async () => {
    const execute = vi.fn(async () => { throw PlatformError.notFound('Article', 'missing'); });

    const outcome = await contentPages.newsArticle.resolve(ctxWith(execute as never), { slug: 'missing' });

    expect(outcome).toEqual({ kind: 'not-found' });
  });

  it('查詢丟出非 not-found 的錯誤要往上拋，不能吞掉', async () => {
    const execute = vi.fn(async () => { throw new Error('db down'); });

    await expect(contentPages.journalArticle.resolve(ctxWith(execute as never), { slug: 'a-slug' }))
      .rejects.toThrow('db down');
  });
});

describe('聯絡頁', () => {
  it('GET 一律回空白表單', async () => {
    const outcome = await contentPages.contact.resolve(ctxWith(vi.fn()), {});

    expect(outcome).toEqual({
      kind: 'view',
      view: { submitted: false, values: { name: '', email: '', subject: '', message: '' } },
    });
  });
});

describe('送出聯絡表單', () => {
  const values = { name: '小明', email: 'a@example.com', subject: '詢問', message: '請問營業時間', website: '' };
  const parse = (raw: Record<string, unknown>) => contentPages.submitContact.input.parse(raw);

  it('成功送出後回填空白並標示 submitted', async () => {
    const commandExecute = vi.fn(async () => ({ id: 'm1' }));

    const outcome = await contentPages.submitContact.resolve(
      ctxWith(vi.fn(), commandExecute as never, { id: `visitor-${Math.random()}`, type: 'service', permissions: [] }),
      parse(values),
    );

    expect(commandExecute).toHaveBeenCalledWith(
      'commerce.content.submitContactMessage',
      { name: '小明', email: 'a@example.com', subject: '詢問', message: '請問營業時間' },
      expect.objectContaining({ actor: expect.any(Object) }),
    );
    expect(outcome).toEqual({
      kind: 'view',
      view: { submitted: true, values: { name: '', email: '', subject: '', message: '' } },
    });
  });

  it('命令失敗時回填原始輸入並帶錯誤訊息，狀態碼 400', async () => {
    const commandExecute = vi.fn(async () => { throw PlatformError.validation('Email 格式錯誤'); });

    const outcome = await contentPages.submitContact.resolve(
      ctxWith(vi.fn(), commandExecute as never, { id: `visitor-${Math.random()}`, type: 'service', permissions: [] }),
      parse(values),
    );

    expect(outcome).toMatchObject({ kind: 'view', status: 400, view: { submitted: false, error: 'Email 格式錯誤' } });
  });

  it('填了 honeypot 欄位就靜默丟棄，回同一頁成功畫面', async () => {
    const commandExecute = vi.fn();

    const outcome = await contentPages.submitContact.resolve(
      ctxWith(vi.fn(), commandExecute as never, { id: `visitor-${Math.random()}`, type: 'service', permissions: [] }),
      parse({ ...values, website: 'http://spam.example' }),
    );

    expect(commandExecute).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      kind: 'view',
      view: { submitted: true, values: { name: '', email: '', subject: '', message: '' } },
    });
  });

  it('同一個節流鍵超過視窗上限時靜默丟棄', async () => {
    const commandExecute = vi.fn(async () => ({ id: 'm1' }));
    const actor: Actor = { id: `throttle-${Math.random()}`, type: 'service', permissions: [] };
    const ctx = ctxWith(vi.fn(), commandExecute as never, actor);

    for (let i = 0; i < 10; i += 1) {
      await contentPages.submitContact.resolve(ctx, parse(values));
    }
    commandExecute.mockClear();

    const outcome = await contentPages.submitContact.resolve(ctx, parse(values));

    expect(commandExecute).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      kind: 'view',
      view: { submitted: true, values: { name: '', email: '', subject: '', message: '' } },
    });
  });

  it('非字串或重複欄位一律視為空字串', () => {
    const parsed = parse({ name: ['x', 'y'], email: { a: 1 }, subject: 123, message: undefined, website: false });

    expect(parsed).toEqual({ name: '', email: '', subject: '', message: '', website: '' });
  });
});
