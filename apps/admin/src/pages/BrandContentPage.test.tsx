import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrandContentPage, bodyToText, textToBody } from './BrandContentPage';
import { I18nProvider } from '../i18n';
import { ApiError, api, type Article } from '../api';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAdminQueryClient } from '../query';
import { AdminOperationProvider, createAdminOperationStore } from '../admin-operations';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      listArticles: vi.fn(),
      createArticle: vi.fn(),
      updateArticle: vi.fn(),
      publishArticle: vi.fn(),
      unpublishArticle: vi.fn(),
      deleteArticle: vi.fn(),
      contentImageKeys: vi.fn(),
    },
  };
});

const article: Article = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'news',
  slug: 'shipping-notice',
  title: '出貨作業公告',
  summary: '出貨天數說明',
  section: '公告',
  body: [{ heading: null, text: '因應連假，出貨將順延一天。' }],
  imageKey: 'hero',
  position: 0,
  status: 'draft',
  publishedAt: null,
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
};

const renderPage = (store = createAdminOperationStore()) => render(<QueryClientProvider client={createAdminQueryClient()}><AdminOperationProvider value={store}><I18nProvider><BrandContentPage /></I18nProvider></AdminOperationProvider></QueryClientProvider>);

beforeEach(() => {
  vi.mocked(api.listArticles).mockReset().mockResolvedValue({ items: [article], total: 1 });
  vi.mocked(api.createArticle).mockReset().mockResolvedValue(article);
  vi.mocked(api.updateArticle).mockReset().mockResolvedValue(article);
  vi.mocked(api.publishArticle).mockReset().mockResolvedValue({ ...article, status: 'published' });
  vi.mocked(api.unpublishArticle).mockReset().mockResolvedValue({ ...article, status: 'draft' });
  vi.mocked(api.deleteArticle).mockReset().mockResolvedValue(article);
  vi.mocked(api.contentImageKeys).mockReset().mockResolvedValue({ keys: ['hero', 'story', 'journal-room', 'journal-pause', 'journal-occasion'] });
});

describe('bodyToText / textToBody', () => {
  it('沒有標題的區塊只留內文，段落間以空行分隔', () => {
    const blocks = [{ heading: null, text: '第一段' }, { heading: null, text: '第二段' }];
    expect(bodyToText(blocks)).toBe('第一段\n\n第二段');
    expect(textToBody(bodyToText(blocks))).toEqual(blocks);
  });

  it('有標題的區塊以「## 標題」開頭', () => {
    const blocks = [{ heading: '01 從手邊開始', text: '故事內文' }];
    expect(bodyToText(blocks)).toBe('## 01 從手邊開始\n故事內文');
    expect(textToBody(bodyToText(blocks))).toEqual(blocks);
  });

  it('混合有標題與無標題的區塊可以正確往返', () => {
    const blocks = [
      { heading: '章節一', text: '內文一' },
      { heading: null, text: '一般段落' },
      { heading: '章節二', text: '內文二' },
    ];
    expect(textToBody(bodyToText(blocks))).toEqual(blocks);
  });

  it('多個空行與前後空白不會產生空區塊', () => {
    expect(textToBody('  第一段  \n\n\n\n第二段  ')).toEqual([
      { heading: null, text: '第一段' },
      { heading: null, text: '第二段' },
    ]);
  });
});

describe('BrandContentPage', () => {
  it('內容讀取失敗不呈現可操作的空表格', async () => {
    vi.mocked(api.listArticles).mockRejectedValue(new Error('articles failed'));
    renderPage();
    expect(await screen.findByText('articles failed')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('清單顯示類型、標題、slug 與狀態', async () => {
    renderPage();

    expect(await screen.findByText('出貨作業公告')).toBeInTheDocument();
    const row = screen.getByText('出貨作業公告').closest('tr')!;
    expect(row).toHaveTextContent('最新消息');
    expect(row).toHaveTextContent('shipping-notice');
    expect(row).toHaveTextContent('草稿');
  });

  it('可以依類型與狀態篩選', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('出貨作業公告');

    await user.selectOptions(screen.getByLabelText('類型'), 'news');
    await waitFor(() => expect(api.listArticles).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'news' }), expect.any(AbortSignal),
    ));

    await user.selectOptions(screen.getByLabelText('狀態'), 'published');
    await waitFor(() => expect(api.listArticles).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'published' }), expect.any(AbortSignal),
    ));
  });

  it('建立抽屜可以送出新內容，內文以空行分段', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('出貨作業公告');

    window.dispatchEvent(new CustomEvent('admin:action:create-article', { cancelable: true }));
    const dialog = await screen.findByRole('dialog', { name: '新增內容' });

    await user.type(within(dialog).getByLabelText('Slug'), 'faq-return');
    await user.type(within(dialog).getByLabelText('標題'), '退換貨常見問題');
    await user.type(within(dialog).getByLabelText('內文'), '第一段\n\n第二段');
    await user.click(within(dialog).getByRole('button', { name: '新增內容' }));

    await waitFor(() => expect(api.createArticle).toHaveBeenCalled());
    expect(vi.mocked(api.createArticle).mock.calls[0][0]).toMatchObject({
      slug: 'faq-return',
      title: '退換貨常見問題',
      body: [{ heading: null, text: '第一段' }, { heading: null, text: '第二段' }],
    });
  });

  it('slug 或內文不合法時擋下送出並提示錯誤', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('出貨作業公告');

    window.dispatchEvent(new CustomEvent('admin:action:create-article', { cancelable: true }));
    const dialog = await screen.findByRole('dialog', { name: '新增內容' });

    await user.type(within(dialog).getByLabelText('標題'), '缺少 Slug');
    await user.click(within(dialog).getByRole('button', { name: '新增內容' }));

    expect(await screen.findByText(/請填寫 Slug/)).toBeInTheDocument();
    expect(api.createArticle).not.toHaveBeenCalled();
  });

  it('編輯抽屜鎖住類型欄位', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('出貨作業公告');

    await user.click(screen.getByRole('button', { name: '編輯' }));
    const dialog = await screen.findByRole('dialog', { name: /編輯/ });

    expect(within(dialog).getByLabelText('類型')).toBeDisabled();
  });

  it('編輯 Dialog 用 Escape 關閉後焦點回到編輯鈕', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('出貨作業公告');

    const trigger = screen.getByRole('button', { name: '編輯' });
    await user.click(trigger);
    expect(await screen.findByRole('dialog', { name: /編輯/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Slug')).toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /編輯/ })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('編輯抽屜不改任何欄位直接送出時擋下並提示，不呼叫 updateArticle', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('出貨作業公告');

    await user.click(screen.getByRole('button', { name: '編輯' }));
    const dialog = await screen.findByRole('dialog', { name: /編輯/ });

    await user.click(within(dialog).getByRole('button', { name: '儲存變更' }));

    expect(await screen.findByText('沒有任何欄位被修改，不必送出。')).toBeInTheDocument();
    expect(api.updateArticle).not.toHaveBeenCalled();
  });

  it('編輯抽屜只送出真正改過的欄位', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('出貨作業公告');

    await user.click(screen.getByRole('button', { name: '編輯' }));
    const dialog = await screen.findByRole('dialog', { name: /編輯/ });

    const titleField = within(dialog).getByLabelText('標題');
    await user.clear(titleField);
    await user.type(titleField, '出貨作業最新公告');
    await user.click(within(dialog).getByRole('button', { name: '儲存變更' }));

    await waitFor(() => expect(api.updateArticle).toHaveBeenCalledWith(article.id, { title: '出貨作業最新公告' }, expect.any(String)));
  });

  it('圖片清單載入失敗時顯示提示，配圖下拉仍可選不配圖', async () => {
    vi.mocked(api.contentImageKeys).mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('出貨作業公告');

    await user.click(screen.getByRole('button', { name: '編輯' }));
    const dialog = await screen.findByRole('dialog', { name: /編輯/ });

    expect(await within(dialog).findByText('圖片清單載入失敗，暫時只能選擇不配圖。')).toBeInTheDocument();
  });

  it('草稿可以發布，發布後可以下架', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('出貨作業公告');

    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    await user.click(await screen.findByRole('menuitem', { name: '上架' }));

    await waitFor(() => expect(api.publishArticle).toHaveBeenCalledWith(article.id, expect.any(String)));
    expect(api.listArticles).toHaveBeenCalledTimes(2);
  });

  it('發布未知時由 recovery 使用原鍵重試', async () => {
    vi.mocked(api.publishArticle).mockRejectedValueOnce(new Error('network lost')).mockResolvedValueOnce({ ...article, status: 'published' });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('出貨作業公告');
    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    await user.click(await screen.findByRole('menuitem', { name: '上架' }));
    await screen.findByText('network lost');
    const firstKey = vi.mocked(api.publishArticle).mock.calls[0][1];
    await user.click(screen.getByRole('button', { name: '以原操作重試' }));
    await waitFor(() => expect(api.publishArticle).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.publishArticle).mock.calls[1][1]).toBe(firstKey);
  });

  it('同篇內容有未知操作時擋住刪除，仍可重試原操作', async () => {
    const store = createAdminOperationStore();
    const operation = { area: 'article', scope: `article:${article.id}`, kind: 'publish' as const, articleId: article.id, request: {}, preview: { title: article.title }, idempotencyKey: 'article-publish-key' };
    store.markUnknown(store.begin(operation)!, new Error('publish uncertain'));
    const user = userEvent.setup();
    renderPage(store);
    await screen.findByText('出貨作業公告');
    expect(screen.getByRole('button', { name: '更多操作' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '以原操作重試' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '以原操作重試' }));
    await waitFor(() => expect(api.publishArticle).toHaveBeenCalledWith(article.id, 'article-publish-key'));
    expect(api.deleteArticle).not.toHaveBeenCalled();
  });

  it('抽屜內重試的明確拒絕保留在抽屜並解鎖欄位', async () => {
    vi.mocked(api.updateArticle).mockRejectedValueOnce(new TypeError('offline')).mockRejectedValueOnce(new ApiError('VALIDATION_ERROR', 'article rejected', 400));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('出貨作業公告');
    await user.click(screen.getByRole('button', { name: '編輯' }));
    const dialog = await screen.findByRole('dialog', { name: /編輯/ });
    await user.clear(within(dialog).getByLabelText('標題'));
    await user.type(within(dialog).getByLabelText('標題'), '重試公告');
    await user.click(within(dialog).getByRole('button', { name: '儲存變更' }));
    await screen.findByText('offline');
    await user.click(within(dialog).getByRole('button', { name: '以原操作重試' }));
    expect(await within(dialog).findByText('article rejected')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('標題')).toBeEnabled();
  });

  it('刪除走確認對話框，不使用 window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('出貨作業公告');

    await user.click(screen.getByRole('button', { name: /更多操作/ }));
    await user.click(await screen.findByRole('menuitem', { name: '刪除' }));

    const dialog = await screen.findByRole('dialog', { name: '刪除這則內容？' });
    await user.click(within(dialog).getByRole('button', { name: '刪除' }));

    await waitFor(() => expect(api.deleteArticle).toHaveBeenCalledWith(article.id, expect.any(String)));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('RowMenu 的刪除確認按 Escape 後焦點回到選單 trigger', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('出貨作業公告');

    const trigger = screen.getByRole('button', { name: /更多操作/ });
    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: '刪除' }));
    expect(await screen.findByRole('dialog', { name: '刪除這則內容？' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '刪除這則內容？' })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
