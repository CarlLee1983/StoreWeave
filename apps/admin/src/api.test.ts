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
