import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ACTOR, createHarness, type TestHarness } from './helpers';

const harnesses: TestHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.close()));
});

async function harnessWithOperator(email = 'operator@example.test') {
  const harness = await createHarness();
  harnesses.push(harness);
  const user = await harness.runtime.commands.execute<{ id: string }>(
    'platform.identity.createUser',
    { email, password: 'operator-password-1', displayName: 'Operator', role: 'staff' },
    { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() },
  );
  return { harness, userId: user.id, email };
}

/** 信件是唯一拿得到 token 的地方——測試刻意不從資料庫讀，那樣就繞過了寄信這一段。 */
async function tokenFromLatestMail(harness: TestHarness, templateId: string): Promise<string> {
  const result = await harness.runtime.database.pool.query<{ text_body: string }>(
    `SELECT text_body FROM public.platform_mail_messages
     WHERE template_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [templateId],
  );
  const body = result.rows[0]?.text_body;
  if (!body) throw new Error(`No ${templateId} mail was queued`);
  const match = /token=([A-Za-z0-9._~%-]+)/.exec(body);
  if (!match) throw new Error(`No token in ${templateId} mail: ${body}`);
  return decodeURIComponent(match[1]);
}

async function mailCount(harness: TestHarness, templateId: string): Promise<number> {
  const result = await harness.runtime.database.pool.query<{ count: string }>(
    'SELECT count(*) AS count FROM public.platform_mail_messages WHERE template_id = $1',
    [templateId],
  );
  return Number(result.rows[0].count);
}

describe('identity signed tokens', () => {
  it('mails a signed, single-use password reset link and revokes every session when it is used', async () => {
    const { harness, email } = await harnessWithOperator();
    const db = harness.runtime.database.db;

    const before = await harness.runtime.auth.authenticate(db, { email, password: 'operator-password-1' });
    await harness.runtime.auth.requestPasswordReset({ email });

    const token = await tokenFromLatestMail(harness, 'identity.password-reset');
    // ADR 0038：離開行程的值一律 `sw1.<keyId>.<到期秒>.<payload>.<mac>`。
    expect(token.split('.')).toHaveLength(5);
    expect(token.startsWith('sw1.')).toBe(true);

    await harness.runtime.auth.resetPassword({ token, newPassword: 'operator-password-2' });
    expect(await harness.runtime.auth.resolveSession(db, before.token)).toBeNull();
    await expect(harness.runtime.auth.authenticate(db, { email, password: 'operator-password-1' })).rejects.toThrow();
    const after = await harness.runtime.auth.authenticate(db, { email, password: 'operator-password-2' });
    expect(after.token).toBeTruthy();

    await expect(
      harness.runtime.auth.resetPassword({ token, newPassword: 'operator-password-3' }),
    ).rejects.toThrow(/invalid or has expired/i);
  });

  it('stays silent for an unknown address and never queues mail for it', async () => {
    const { harness } = await harnessWithOperator();
    const db = harness.runtime.database.db;

    await expect(harness.runtime.auth.requestPasswordReset({ email: 'nobody@example.test' })).resolves.toBeUndefined();
    expect(await mailCount(harness, 'identity.password-reset')).toBe(0);
  });

  it('rejects a tampered signature and a token presented for another purpose', async () => {
    const { harness, email } = await harnessWithOperator();
    const db = harness.runtime.database.db;
    await harness.runtime.auth.requestPasswordReset({ email });
    const token = await tokenFromLatestMail(harness, 'identity.password-reset');

    const parts = token.split('.');
    const tampered = [...parts.slice(0, 4), `${parts[4].slice(0, -2)}aa`].join('.');
    await expect(harness.runtime.auth.resetPassword({ token: tampered, newPassword: 'operator-password-2' }))
      .rejects.toThrow(/invalid or has expired/i);
    // 同一把 root secret，不同用途推導出不同子金鑰：重設 token 不能拿去驗信箱。
    await expect(harness.runtime.auth.verifyEmail({ token })).rejects.toThrow(/invalid or has expired/i);
  });

  it('invalidates the previous reset link when a second one is requested', async () => {
    const { harness, email } = await harnessWithOperator();
    const db = harness.runtime.database.db;

    await harness.runtime.auth.requestPasswordReset({ email });
    const first = await tokenFromLatestMail(harness, 'identity.password-reset');
    await harness.runtime.auth.requestPasswordReset({ email });
    const second = await tokenFromLatestMail(harness, 'identity.password-reset');
    expect(second).not.toBe(first);

    await expect(harness.runtime.auth.resetPassword({ token: first, newPassword: 'operator-password-2' }))
      .rejects.toThrow(/invalid or has expired/i);
    await expect(harness.runtime.auth.resetPassword({ token: second, newPassword: 'operator-password-2' }))
      .resolves.toBeDefined();
  });

  it('keeps token creation and its mail in one transaction', async () => {
    const { harness, email } = await harnessWithOperator();
    const db = harness.runtime.database.db;
    const queue = harness.runtime.mail.queue.bind(harness.runtime.mail);
    harness.runtime.mail.queue = async () => { throw new Error('smtp bookkeeping exploded'); };

    await expect(harness.runtime.auth.requestPasswordReset({ email })).rejects.toThrow(/exploded/);
    harness.runtime.mail.queue = queue;

    const rows = await harness.runtime.database.pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM platform_identity_tokens',
    );
    // 信寄不出去就不該留下一個「已發出但沒人收到」的 token。
    expect(Number(rows.rows[0].count)).toBe(0);
  });

  it('caps an operator reset link at fifteen minutes regardless of the requested window', async () => {
    const { harness, email, userId } = await harnessWithOperator();
    const db = harness.runtime.database.db;

    await harness.runtime.auth.requestPasswordReset({ email, ttlMs: 24 * 60 * 60_000 });
    const row = await harness.runtime.database.pool.query<{ expires_at: Date }>(
      `SELECT expires_at FROM platform_identity_tokens WHERE user_id = $1 AND purpose = 'password-reset'`,
      [userId],
    );
    expect(row.rows[0].expires_at.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 5_000);
  });

  it('verifies an address only after its mailed link is presented', async () => {
    const { harness, userId } = await harnessWithOperator();
    const db = harness.runtime.database.db;

    const unverified = await harness.runtime.database.pool.query<{ email_verified_at: Date | null }>(
      'SELECT email_verified_at FROM platform_users WHERE id = $1', [userId],
    );
    expect(unverified.rows[0].email_verified_at).toBeNull();

    await harness.runtime.auth.requestEmailVerification({ userId });
    const token = await tokenFromLatestMail(harness, 'identity.email-verification');
    await harness.runtime.auth.verifyEmail({ token });

    const verified = await harness.runtime.database.pool.query<{ email_verified_at: Date | null }>(
      'SELECT email_verified_at FROM platform_users WHERE id = $1', [userId],
    );
    expect(verified.rows[0].email_verified_at).not.toBeNull();
    await expect(harness.runtime.auth.verifyEmail({ token })).rejects.toThrow(/invalid or has expired/i);
  });

  it('holds a new address encrypted until the change is confirmed from that address', async () => {
    const { harness, email, userId } = await harnessWithOperator();
    const db = harness.runtime.database.db;
    const next = 'operator-new@example.test';

    await harness.runtime.auth.requestEmailChange({
      userId, currentPassword: 'operator-password-1', newEmail: next,
    });

    const pending = await harness.runtime.database.pool.query<{ data: string; }>(
      `SELECT data FROM platform_identity_tokens WHERE user_id = $1 AND purpose = 'email-change'`, [userId],
    );
    // 未確認的新信箱是個人資料：資料庫裡不能是明文。
    expect(pending.rows[0].data).not.toContain(next);
    expect(pending.rows[0].data.startsWith('swe1.')).toBe(true);

    const mail = await harness.runtime.database.pool.query<{ recipients: { email: string }[] }>(
      `SELECT recipients FROM public.platform_mail_messages WHERE template_id = 'identity.email-change' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(mail.rows[0].recipients.map(recipient => recipient.email)).toEqual([next]);

    const token = await tokenFromLatestMail(harness, 'identity.email-change');
    await harness.runtime.auth.confirmEmailChange({ token });

    await expect(harness.runtime.auth.authenticate(db, { email, password: 'operator-password-1' })).rejects.toThrow();
    const session = await harness.runtime.auth.authenticate(db, { email: next, password: 'operator-password-1' });
    expect(session.user.email).toBe(next);
  });

  it('refuses an email change to an address another account already uses', async () => {
    const { harness, userId } = await harnessWithOperator();
    const db = harness.runtime.database.db;
    await harness.runtime.commands.execute(
      'platform.identity.createUser',
      { email: 'taken@example.test', password: 'other-password-11', displayName: 'Other', role: 'staff' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() },
    );

    await expect(harness.runtime.auth.requestEmailChange({
      userId, currentPassword: 'operator-password-1', newEmail: 'taken@example.test',
    })).rejects.toThrow();
    expect(await mailCount(harness, 'identity.email-change')).toBe(0);
  });

  it('refuses an email change without the current password', async () => {
    const { harness, userId } = await harnessWithOperator();
    const db = harness.runtime.database.db;
    await expect(harness.runtime.auth.requestEmailChange({
      userId, currentPassword: 'wrong-password', newEmail: 'operator-new@example.test',
    })).rejects.toThrow();
    expect(await mailCount(harness, 'identity.email-change')).toBe(0);
  });
});
