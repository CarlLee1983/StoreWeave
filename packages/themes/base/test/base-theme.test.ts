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
  it('服務通用頁與認證頁，沒有任何商務頁的 renderer', () => {
    expect(Object.keys(baseTheme.renderers).sort())
      .toEqual([
        'platform.auth', 'platform.auth.forgotPassword', 'platform.auth.login',
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

  it('把資料當文字輸出', () => {
    const ctx = context({
      storeName: PROBE, tagline: PROBE, footerNote: PROBE, supportEmail: PROBE,
      navigation: { primary: [{ label: PROBE, href: `/${PROBE}` }], footer: [] },
    });
    for (const html of [
      baseTheme.renderers['platform.site.home'](ctx, {}),
      baseTheme.renderers['platform.error'](ctx, { status: 404, message: PROBE }),
      baseTheme.renderers['platform.auth'](ctx, { mode: 'login', next: PROBE, error: PROBE }),
    ]) {
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    }
  });
});
