import { describe, expect, it } from 'vitest';
import type { ThemeContext } from '@storeweave/kernel';
import { baseTheme } from '../src/index';

const PROBE = '"><script>alert(1)</script>';

const context = (overrides: Partial<ThemeContext> = {}): ThemeContext => ({
  storeName: '公司網站',
  storeId: 'base-site',
  locale: 'zh-TW',
  timeZone: 'Asia/Taipei',
  publicUrl: 'https://example.test',
  options: { accentColor: '#2F5D62' },
  tagline: '一個沒有商務的網站',
  navigation: { primary: [{ label: '首頁', href: '/' }], footer: [{ label: '隱私權', href: '/privacy' }] },
  customerName: null,
  csrfToken: null,
  notice: null,
  ...overrides,
});

describe('Base Theme', () => {
  it('服務通用、認證與網站內容頁；不認得購物車或商品', () => {
    expect(Object.keys(baseTheme.renderers).sort())
      .toEqual([
        'commerce.content.contact', 'commerce.content.faq', 'commerce.content.journalArticle',
        'commerce.content.journalList', 'commerce.content.newsArticle', 'commerce.content.newsList',
        'commerce.content.story', 'commerce.content.submitContact',
        'platform.auth.forgotPassword', 'platform.auth.login',
        'platform.auth.register', 'platform.auth.resetPassword', 'platform.auth.submitForgotPassword',
        'platform.auth.submitLogin', 'platform.auth.submitRegister', 'platform.auth.submitResetPassword',
        'platform.error', 'platform.site.home',
      ]);
  });

  it('首頁印出資料給的導覽與標語，沒有寫死的連結', () => {
    const html = baseTheme.renderers['platform.site.home'](context(), {});
    expect(html).toContain('<a href="/">首頁</a>');
    expect(html).toContain('<a href="/privacy">隱私權</a>');
    expect(html).toContain('一個沒有商務的網站');
    expect(html).not.toContain('/cart');
  });

  it('沒有導覽資料時仍然渲染得出頁面', () => {
    const html = baseTheme.renderers['platform.site.home'](context({ navigation: {}, tagline: undefined }), {});
    expect(html).toContain('公司網站');
    expect(html).toContain('<nav class="site-nav" aria-label="主要導覽"></nav>');
  });

  it('重設密碼表單只送 token 與新密碼，不要求無用的 email', () => {
    const html = baseTheme.renderers['platform.auth.resetPassword'](context(), {
      mode: 'reset-password', next: '/', token: 'reset-token',
    });

    expect(html).toContain('name="token" value="reset-token"');
    expect(html).toContain('name="password" type="password" autocomplete="new-password"');
    expect(html).not.toContain('name="email"');
  });

  it('登入、註冊與忘記密碼都有信箱欄位，只有重設密碼沒有（工單 98）', () => {
    for (const id of ['platform.auth.login', 'platform.auth.register', 'platform.auth.forgotPassword']) {
      const view = id === 'platform.auth.login' ? { mode: 'login', next: '/' }
        : id === 'platform.auth.register' ? { mode: 'register', next: '/' }
          : { mode: 'forgot-password', next: '/' };
      expect(baseTheme.renderers[id](context(), view)).toContain('name="email"');
    }
  });

  it('註冊表單要求新密碼並標出長度下限', () => {
    const html = baseTheme.renderers['platform.auth.register'](context(), { mode: 'register', next: '/' });

    expect(html).toContain('autocomplete="new-password"');
    expect(html).toContain('minlength="8"');
  });

  it('密碼欄位永遠不帶預填值', () => {
    for (const [id, view] of [
      ['platform.auth.login', { mode: 'login', next: '/', email: 'someone@example.com' }],
      ['platform.auth.register', { mode: 'register', next: '/' }],
      ['platform.auth.resetPassword', { mode: 'reset-password', next: '/', token: 't' }],
    ] as const) {
      expect(baseTheme.renderers[id](context(), view)).not.toMatch(/type="password"[^>]*value=/);
    }
  });

  it('登入失敗重新渲染時把填過的信箱放回欄位（工單 98）', () => {
    const html = baseTheme.renderers['platform.auth.submitLogin'](context(), {
      mode: 'login', next: '/', error: '登入失敗：請確認電子郵件與密碼。', email: 'someone@example.com',
    });

    expect(html).toContain('value="someone@example.com"');
  });

  it('把資料當文字輸出', () => {
    const ctx = context({
      storeName: PROBE, tagline: PROBE, footerNote: PROBE, supportEmail: PROBE,
      navigation: { primary: [{ label: PROBE, href: `/${PROBE}` }], footer: [] },
    });
    for (const html of [
      baseTheme.renderers['platform.site.home'](ctx, {}),
      baseTheme.renderers['platform.error'](ctx, { status: 404, message: PROBE }),
      baseTheme.renderers['platform.auth.login'](ctx, { mode: 'login', next: PROBE, error: PROBE, email: PROBE }),
      baseTheme.renderers['platform.auth.register'](ctx, { mode: 'register', next: PROBE, error: PROBE }),
      baseTheme.renderers['platform.auth.forgotPassword'](ctx, { mode: 'forgot-password', next: PROBE, notice: PROBE }),
      baseTheme.renderers['platform.auth.resetPassword'](ctx, { mode: 'reset-password', next: PROBE, error: PROBE, token: PROBE }),
      baseTheme.renderers['commerce.content.newsArticle'](ctx, {
        article: { kind: 'news', slug: 'probe', title: PROBE, summary: PROBE, section: PROBE,
          body: [{ heading: PROBE, text: PROBE }], imageKey: null, publishedAt: null },
      }),
      baseTheme.renderers['commerce.content.submitContact'](ctx, {
        submitted: false, error: PROBE, values: { name: PROBE, email: PROBE, subject: PROBE, message: PROBE },
      }),
    ]) {
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    }
  });
});
