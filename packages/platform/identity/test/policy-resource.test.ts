import { describe, expect, it } from 'vitest';
import { setUserStatusCommand } from '../src/module';

/**
 * Command Bus 由 command 名稱的第二段推導 policy 的 resource type
 * （`platform.identity.setUserStatus` → `identity`），而 no-self-disable 這條
 * policy 只在 type 是 `identity` 時才判斷。改名或改成別的命名分段，policy 會
 * 安靜地 abstain——「不能停用自己」就這樣消失，沒有任何東西會失敗。
 * 這個測試把那條隱含契約釘住，讓改名變成一次紅燈而不是一個沉默的漏洞。
 */
describe('identity policy resource contract', () => {
  it('keeps the command name that the no-self-disable policy reads its resource type from', () => {
    expect(setUserStatusCommand.name).toBe('platform.identity.setUserStatus');
    expect(setUserStatusCommand.name.split('.')[1]).toBe('identity');
    expect(setUserStatusCommand.resource?.({ userId: 'u1', status: 'disabled' }))
      .toMatchObject({ id: 'u1', attributes: { status: 'disabled' } });
  });
});
