/**
 * @vitest-environment-options { "url": "https://admin.example.test/" }
 *
 * 這個檔案跑在 https 的 jsdom 上：`__Host-` 前綴的 cookie 需要 Secure，
 * 而 Secure 在 http 頁面上會被 jsdom（與真正的瀏覽器）拒收。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api';

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function clearCookies() {
  for (const entry of document.cookie.split(';')) {
    const name = entry.split('=')[0]?.trim();
    // 帶 Secure：沒有它，`__Host-` 開頭的那一張連刪除都會被拒絕，會漏到下一條測試。
    if (name) document.cookie = `${name}=; Max-Age=0; path=/; Secure`;
  }
}

function sentHeaders(): Record<string, string> {
  return (fetch as unknown as { mock: { calls: [string, { headers: Record<string, string> }][] } })
    .mock.calls[0][1].headers;
}

/**
 * cookie 的名字在 https 部署上會多一個 `__Host-` 前綴，本機 http 開發沒有（ADR 0023），
 * 而這支前端建置時不知道自己會跑在哪一種，因此兩個都認得。
 */
describe('CSRF token 從 cookie 讀出來', () => {
  afterEach(clearCookies);

  it('兩張都在時取帶前綴的那一張——它是子網域蓋不掉的那一張', async () => {
    mockFetch(200, { success: true, data: null });
    document.cookie = 'commerce_csrf=bare-value; path=/';
    document.cookie = '__Host-commerce_csrf=prefixed-value; path=/; Secure';

    await api.logout();

    expect(sentHeaders()['x-csrf-token']).toBe('prefixed-value');
  });

  it('只有裸名時就用裸名——裸名的比對不會誤匹配到前綴名的那一張', async () => {
    mockFetch(200, { success: true, data: null });
    document.cookie = 'commerce_csrf=bare-value; path=/';

    await api.logout();

    expect(sentHeaders()['x-csrf-token']).toBe('bare-value');
  });

  it('只有前綴名時也讀得到', async () => {
    mockFetch(200, { success: true, data: null });
    document.cookie = '__Host-commerce_csrf=prefixed-value; path=/; Secure';

    await api.logout();

    expect(sentHeaders()['x-csrf-token']).toBe('prefixed-value');
  });

  it('一張都沒有時不送這個 header', async () => {
    mockFetch(200, { success: true, data: null });

    await api.logout();

    expect(sentHeaders()).not.toHaveProperty('x-csrf-token');
  });
});

describe('健康端點的原始回應', () => {
  it('session 過期時丟出 ApiError，而不是把錯誤信封當成健康報告', async () => {
    mockFetch(401, { success: false, error: { code: 'UNAUTHENTICATED', message: 'Missing bearer token' } });

    await expect(api.healthDependencies()).rejects.toBeInstanceOf(ApiError);
    await expect(api.healthDependencies()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('成功時回傳原始物件', async () => {
    mockFetch(200, { status: 'ok', checks: [{ name: 'postgres', status: 'pass' }] });

    await expect(api.healthDependencies()).resolves.toMatchObject({ status: 'ok' });
  });
});
