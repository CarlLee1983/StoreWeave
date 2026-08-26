import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrandContentPage, bodyToText, textToBody } from './BrandContentPage';
import { I18nProvider } from '../i18n';
import { api, type Article } from '../api';

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

const renderPage = () => render(<I18nProvider><BrandContentPage /></I18nProvider>);

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
      expect.objectContaining({ kind: 'news' }),
    ));

    await user.selectOptions(screen.getByLabelText('狀態'), 'published');
    await waitFor(() => expect(api.listArticles).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'published' }),
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

    await waitFor(() => expect(api.updateArticle).toHaveBeenCalledWith(article.id, { title: '出貨作業最新公告' }));
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

    await waitFor(() => expect(api.publishArticle).toHaveBeenCalledWith(article.id));
    expect(api.listArticles).toHaveBeenCalledTimes(2);
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

    await waitFor(() => expect(api.deleteArticle).toHaveBeenCalledWith(article.id));
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
