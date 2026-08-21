import { randomUUID } from 'node:crypto';
import { sql as sqlRaw } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ACTOR, actorWith, createHarness, type TestHarness } from './helpers';

let h: TestHarness;

beforeAll(async () => {
  h = await createHarness();
}, 300_000);

afterAll(async () => {
  await h?.close();
});

const password = 'a-sufficiently-long-passphrase';

async function createUser(email: string, role = 'staff') {
  return h.runtime.commands.execute<{ id: string; email: string; role: string; status: string }>(
    'platform.identity.createUser',
    { email, password, displayName: email.split('@')[0], role },
    { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() },
  );
}

describe('操作者帳號', () => {
  it('建立帳號後可以列出，且回應不含密碼雜湊', async () => {
    const email = `ops-${randomUUID().slice(0, 8)}@example.com`;
    const created = await createUser(email);
    expect(created).toMatchObject({ email, role: 'staff', status: 'active' });
    expect(JSON.stringify(created)).not.toContain('scrypt');

    const listed = await h.runtime.queries.execute<{ items: { id: string; email: string }[] }>(
      'platform.identity.listUsers', {}, { actor: ADMIN_ACTOR },
    );
    expect(listed.items.map((u) => u.email)).toContain(email);
    expect(JSON.stringify(listed)).not.toContain('scrypt');
  });

  it('同一個 email 不能建立兩次', async () => {
    const email = `dup-${randomUUID().slice(0, 8)}@example.com`;
    await createUser(email);
    await expect(createUser(email)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('email 大小寫不同視為同一個帳號', async () => {
    const email = `case-${randomUUID().slice(0, 8)}@example.com`;
    await createUser(email);
    await expect(createUser(email.toUpperCase())).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('不能指派不存在的角色', async () => {
    await expect(createUser(`bad-${randomUUID().slice(0, 8)}@example.com`, 'wizard'))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('原型鏈上的鍵不算合法角色', async () => {
    for (const role of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      await expect(createUser(`proto-${randomUUID().slice(0, 8)}@example.com`, role))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });

  it('沒有 users:write 權限就不能建立帳號', async () => {
    await expect(
      h.runtime.commands.execute('platform.identity.createUser',
        { email: `no-${randomUUID().slice(0, 8)}@example.com`, password, displayName: 'x', role: 'staff' },
        { actor: actorWith(['users:read']), idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('太短的密碼會被拒絕', async () => {
    await expect(
      h.runtime.commands.execute('platform.identity.createUser',
        { email: `short-${randomUUID().slice(0, 8)}@example.com`, password: 'short', displayName: 'x', role: 'staff' },
        { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('登入與 session', () => {
  it('正確帳密換到 session token，且資料庫存的不是原文', async () => {
    const email = `login-${randomUUID().slice(0, 8)}@example.com`;
    await createUser(email, 'admin');

    const session = await h.runtime.auth.authenticate(h.runtime.database.db, { email, password });
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const stored = await h.runtime.database.db.execute<{ token_hash: string }>(
      sqlRaw`SELECT token_hash FROM platform_sessions`,
    );
    expect(stored.rows.map((r) => r.token_hash)).not.toContain(session.token);
  });

  it('session token 解析成帶有該角色權限的 Actor', async () => {
    const email = `actor-${randomUUID().slice(0, 8)}@example.com`;
    await createUser(email, 'readonly');
    const session = await h.runtime.auth.authenticate(h.runtime.database.db, { email, password });

    const resolved = await h.runtime.auth.resolveSession(h.runtime.database.db, session.token);
    expect(resolved).not.toBeNull();
    expect(resolved!.actor.type).toBe('user');
    expect(resolved!.actor.permissions).toContain('catalog:read');
    expect(resolved!.actor.permissions).not.toContain('catalog:write');
    // Actor 要能歸屬到人，audit log 才有意義
    expect(resolved!.actor.id).toContain(resolved!.user.id);
  });

  it('密碼錯誤與帳號不存在給出無法區分的失敗', async () => {
    const email = `wrong-${randomUUID().slice(0, 8)}@example.com`;
    await createUser(email);

    const wrongPassword = h.runtime.auth.authenticate(h.runtime.database.db, { email, password: 'definitely-not-it' });
    const noSuchUser = h.runtime.auth.authenticate(h.runtime.database.db, { email: 'ghost@example.com', password });

    await expect(wrongPassword).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(noSuchUser).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const [a, b] = await Promise.all([
      wrongPassword.catch((e) => e.message), noSuchUser.catch((e) => e.message),
    ]);
    expect(a).toBe(b);
  });

  it('登出後同一個 token 立刻失效', async () => {
    const email = `out-${randomUUID().slice(0, 8)}@example.com`;
    await createUser(email);
    const session = await h.runtime.auth.authenticate(h.runtime.database.db, { email, password });

    await h.runtime.auth.revokeSession(h.runtime.database.db, session.token);
    await expect(h.runtime.auth.resolveSession(h.runtime.database.db, session.token)).resolves.toBeNull();
  });

  it('過期的 session 不能用', async () => {
    const email = `exp-${randomUUID().slice(0, 8)}@example.com`;
    await createUser(email);
    const session = await h.runtime.auth.authenticate(h.runtime.database.db, { email, password });

    await h.runtime.database.db.execute(sqlRaw`UPDATE platform_sessions SET expires_at = now() - interval '1 second'`);
    await expect(h.runtime.auth.resolveSession(h.runtime.database.db, session.token)).resolves.toBeNull();
  });

  it('停用的帳號不能登入', async () => {
    const email = `off-${randomUUID().slice(0, 8)}@example.com`;
    const user = await createUser(email);
    await h.runtime.database.db.execute(sqlRaw`UPDATE platform_users SET status = 'disabled' WHERE id = ${user.id}`);

    await expect(h.runtime.auth.authenticate(h.runtime.database.db, { email, password }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
