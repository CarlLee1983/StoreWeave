import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ACTOR, createHarness, type TestHarness } from './helpers';

const harnesses: TestHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.close()));
});

const PASSWORD = 'operator-password-1';

async function operator(role = 'staff') {
  const harness = await createHarness();
  harnesses.push(harness);
  const email = `${randomUUID()}@example.test`;
  const user = await harness.runtime.commands.execute<{ id: string }>(
    'platform.identity.createUser',
    { email, password: PASSWORD, displayName: 'Operator', role },
    { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() },
  );
  return { harness, email, userId: user.id, db: harness.runtime.database.db };
}

const login = (context: Awaited<ReturnType<typeof operator>>, password: string) =>
  context.harness.runtime.auth.authenticate(context.db, { email: context.email, password });

describe('account security', () => {
  it('locks an account after repeated failures and says nothing different about it', async () => {
    const context = await operator();
    let wrongMessage = '';
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await login(context, 'not-the-password').catch((error: Error) => { wrongMessage = error.message; });
    }

    // 鎖定期間即使密碼正確也不放行，而且訊息與密碼錯誤一字不差。
    const locked = await login(context, PASSWORD).catch((error: Error) => error.message);
    expect(locked).toBe(wrongMessage);

    const row = await context.harness.runtime.database.pool.query<{ locked_until: Date | null; failed_login_count: number }>(
      'SELECT locked_until, failed_login_count FROM platform_users WHERE id = $1', [context.userId]);
    expect(row.rows[0].failed_login_count).toBe(10);
    expect(row.rows[0].locked_until!.getTime()).toBeGreaterThan(Date.now());
  });

  it('clears the counter once a login succeeds', async () => {
    const context = await operator();
    for (let attempt = 0; attempt < 3; attempt += 1) await login(context, 'wrong').catch(() => undefined);
    await login(context, PASSWORD);

    const row = await context.harness.runtime.database.pool.query<{ locked_until: Date | null; failed_login_count: number }>(
      'SELECT locked_until, failed_login_count FROM platform_users WHERE id = $1', [context.userId]);
    expect(row.rows[0]).toMatchObject({ failed_login_count: 0, locked_until: null });
  });

  it('lets the lock expire without an operator having to intervene', async () => {
    const context = await operator();
    for (let attempt = 0; attempt < 10; attempt += 1) await login(context, 'wrong').catch(() => undefined);
    await expect(login(context, PASSWORD)).rejects.toThrow();

    await context.harness.runtime.database.pool.query(
      `UPDATE platform_users SET locked_until = now() - interval '1 second' WHERE id = $1`, [context.userId]);
    await expect(login(context, PASSWORD)).resolves.toBeDefined();
  });

  it('starts the count over once a lock has expired, so one wrong password cannot re-lock', async () => {
    const context = await operator();
    for (let attempt = 0; attempt < 10; attempt += 1) await login(context, 'wrong').catch(() => undefined);
    await context.harness.runtime.database.pool.query(
      `UPDATE platform_users SET locked_until = now() - interval '1 second' WHERE id = $1`, [context.userId]);

    // 鎖過期之後的第一次失敗只是第一次失敗。否則知道信箱的人每十五分鐘打一次
    // 就能把帳號永久鎖住，而合法使用者等不到任何一個沒有人在打的窗口。
    await login(context, 'wrong').catch(() => undefined);
    const row = await context.harness.runtime.database.pool.query<{ locked_until: Date | null; failed_login_count: number }>(
      'SELECT locked_until, failed_login_count FROM platform_users WHERE id = $1', [context.userId]);
    expect(row.rows[0]).toMatchObject({ failed_login_count: 1, locked_until: null });
    await expect(login(context, PASSWORD)).resolves.toBeDefined();
  });

  it('clears the lock when the password is reset, so a locked-out operator has a way back in', async () => {
    const context = await operator();
    for (let attempt = 0; attempt < 10; attempt += 1) await login(context, 'wrong').catch(() => undefined);

    await context.harness.runtime.auth.requestPasswordReset({ email: context.email });
    const mail = await context.harness.runtime.database.pool.query<{ text_body: string }>(
      `SELECT text_body FROM public.platform_mail_messages
       WHERE template_id = 'identity.password-reset' ORDER BY created_at DESC LIMIT 1`);
    const token = decodeURIComponent(/token=([A-Za-z0-9._~%-]+)/.exec(mail.rows[0].text_body)![1]);
    await context.harness.runtime.auth.resetPassword({ token, newPassword: 'a-brand-new-password-1' });

    await expect(login(context, 'a-brand-new-password-1')).resolves.toBeDefined();
  });

  it('revokes every session the moment an account is disabled', async () => {
    const context = await operator();
    const session = await login(context, PASSWORD);
    expect(await context.harness.runtime.auth.resolveSession(context.db, session.token)).not.toBeNull();

    await context.harness.runtime.commands.execute('platform.identity.setUserStatus',
      { userId: context.userId, status: 'disabled' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    expect(await context.harness.runtime.auth.resolveSession(context.db, session.token)).toBeNull();
    await expect(login(context, PASSWORD)).rejects.toThrow();

    await context.harness.runtime.commands.execute('platform.identity.setUserStatus',
      { userId: context.userId, status: 'active' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    await expect(login(context, PASSWORD)).resolves.toBeDefined();
  });

  it('refuses to let an operator disable their own account', async () => {
    const context = await operator('admin');
    const session = await login(context, PASSWORD);
    const actor = (await context.harness.runtime.auth.resolveSession(context.db, session.token))!.actor;

    await expect(context.harness.runtime.commands.execute('platform.identity.setUserStatus',
      { userId: context.userId, status: 'disabled' },
      { actor, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // 停用別人仍然可以——被拒絕的是「自己」，不是這個命令。
    const other = await context.harness.runtime.commands.execute<{ id: string }>('platform.identity.createUser',
      { email: `${randomUUID()}@example.test`, password: PASSWORD, displayName: 'Other', role: 'staff' },
      { actor, idempotencyKey: randomUUID() });
    await expect(context.harness.runtime.commands.execute('platform.identity.setUserStatus',
      { userId: other.id, status: 'disabled' },
      { actor, idempotencyKey: randomUUID() })).resolves.toBeDefined();
  });

  it('applies a demotion to the session that is already open', async () => {
    const context = await operator('admin');
    const session = await login(context, PASSWORD);
    expect((await context.harness.runtime.auth.resolveSession(context.db, session.token))!.actor.permissions)
      .toEqual(['*']);

    await context.harness.runtime.database.pool.query(
      `UPDATE platform_users SET role = 'readonly' WHERE id = $1`, [context.userId]);

    // Session 不快取權限：降權在下一個請求就生效，不必等它過期。
    const after = await context.harness.runtime.auth.resolveSession(context.db, session.token);
    expect(after!.actor.permissions).not.toContain('*');
    expect(after!.actor.permissions).toContain('catalog:read');
  });

  it('drops a session whose role no longer exists in the release', async () => {
    const context = await operator();
    const session = await login(context, PASSWORD);
    await context.harness.runtime.database.pool.query(
      `UPDATE platform_users SET role = 'role-that-was-removed' WHERE id = $1`, [context.userId]);
    expect(await context.harness.runtime.auth.resolveSession(context.db, session.token)).toBeNull();
  });
});
