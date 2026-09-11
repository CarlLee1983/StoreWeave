import { describe, expect, it, vi } from 'vitest';
import { startSession } from '../../apps/api/src/http/session-start';
import type { Runtime } from '../../apps/api/src/tokens';
import type { AuthenticatedRequest } from '../../apps/api/src/http/auth';

/**
 * 沒有購物車模組的 release（形象站）不該嘗試合併，也不該因此在 log 裡留下失敗。
 *
 * 這是工單 92 把兩份簽發實作併成一份的代價所在：合併那一步改成問註冊表。問錯順序
 * （先 resolveSession 再問）會讓形象站每次登入都多一次資料庫往返，放棄判斷則會讓它
 * 每次登入都記一筆 `guest cart merge failed`。這支測試把兩者都釘住。
 */
function runtimeWithoutCart(commands: { has: () => boolean; execute: ReturnType<typeof vi.fn> }) {
  return {
    config: { http: { publicUrl: 'https://site.internal' } },
    commands,
    logger: { error: vi.fn() },
    auth: { resolveSession: vi.fn() },
    database: { db: {} },
  } as unknown as Runtime & {
    logger: { error: ReturnType<typeof vi.fn> };
    auth: { resolveSession: ReturnType<typeof vi.fn> };
  };
}

const replyStub = () => ({ setCookie: vi.fn(), clearCookie: vi.fn() }) as never;
// publicUrl 是 https，所以訪客購物車 cookie 帶 __Host- 前綴（cookie-names.ts 不回退到裸名）。
const requestWithCart = { cookies: { '__Host-commerce_cart': 'a-guest-cart-token' } } as unknown as AuthenticatedRequest;
const session = { token: 'session-token', expiresAt: new Date(Date.now() + 60_000) } as never;

describe('沒有購物車模組時的 session 簽發', () => {
  it('不呼叫合併、不記錄失敗，也不白跑一次 resolveSession', async () => {
    const execute = vi.fn();
    const runtime = runtimeWithoutCart({ has: () => false, execute });

    const notice = await startSession(runtime, requestWithCart, replyStub(), session);

    expect(notice).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    expect(runtime.logger.error).not.toHaveBeenCalled();
    // 問註冊表要在查 session 之前：否則形象站每次登入都多一次資料庫往返。
    expect(runtime.auth.resolveSession).not.toHaveBeenCalled();
  });

  it('有購物車模組時照舊走合併那條路', async () => {
    const execute = vi.fn().mockResolvedValue({ removedNames: [] });
    const runtime = runtimeWithoutCart({ has: () => true, execute });
    runtime.auth.resolveSession.mockResolvedValue({ actor: { id: 'c1', type: 'customer', permissions: [] } });

    await startSession(runtime, requestWithCart, replyStub(), session);

    expect(execute).toHaveBeenCalledWith(
      'commerce.cart.mergeGuestCart',
      { guestToken: 'a-guest-cart-token' },
      expect.objectContaining({ channel: 'rest' }),
    );
    expect(runtime.logger.error).not.toHaveBeenCalled();
  });
});
