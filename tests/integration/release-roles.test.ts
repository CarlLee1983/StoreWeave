import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_ROLES, COMMERCE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger } from '@storeweave/contracts';
import { AuthService, IdentityTokenService, accountService, hashPassword } from '@storeweave/identity';
import { createRuntime, type Runtime } from '@storeweave/kernel';
import { ADMIN_ACTOR, createTestDatabase, testSecretProvider } from './helpers';

let runtime: Runtime;
const password = 'release-role-passphrase';
beforeAll(async () => {
  runtime = await createRuntime({
    release: { id: 'test', version: '1.0.0', buildManifestChecksum: `sha256:${'0'.repeat(64)}` },
    roles: BASE_ROLES, config: baseConfigSchema.parse({
      version: 1, store: { id: 'base-test', name: 'Base' }, database: { url: await createTestDatabase() },
      security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
    }),
    secrets: testSecretProvider({ SW_SIGNING_KEY_TEST: Buffer.alloc(32, 3).toString('base64url') }),
    logger: noopLogger, modules: [], availableExtensions: {},
  });
  await runtime.migrate();
});
afterAll(async () => runtime?.close());

async function create(role: string) {
  const email = `${randomUUID()}@example.com`;
  const user = await runtime.commands.execute<{ id: string }>('platform.identity.createUser',
    { email, password, displayName: role, role }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
  return { email, user };
}

async function pendingTokens(email: string): Promise<number> {
  const result = await runtime.database.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM platform_identity_tokens t
     JOIN platform_users u ON u.id = t.user_id
     WHERE lower(u.email) = lower($1) AND t.used_at IS NULL`, [email]);
  return result.rows[0].n;
}

describe('release-owned roles', () => {
  it('Base staff cannot create an administrator', async () => {
    const email = `${randomUUID()}@example.com`;
    await expect(runtime.commands.execute('platform.identity.createUser',
      { email, password, displayName: 'Escalation attempt', role: 'admin' },
      { actor: runtime.actorForRole('staff'), idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await runtime.database.pool.query('SELECT id FROM platform_users WHERE email = $1', [email])).rows).toEqual([]);
  });
  it('Base uses only its own account and actor permissions', async () => {
    const { email } = await create('readonly');
    const issued = await runtime.auth.authenticate(runtime.database.db, { email, password });
    const session = await runtime.auth.resolveSession(runtime.database.db, issued.token);
    expect(session?.actor).toMatchObject({ type: 'user', permissions: ['users:read', 'jobs:read', 'storage:read', 'notifications:read', 'notifications:inbox'] });
    expect(runtime.actorForRole('staff').permissions).not.toContain('order:read');
    for (const role of ['customer', 'storefront', 'mcp', 'constructor']) {
      expect(() => runtime.actorForRole(role)).toThrow('Unknown role');
      await expect(create(role)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });

  it('a legacy customer cannot authenticate, resolve, or reset through Base policy', async () => {
    const email = `${randomUUID()}@example.com`;
    const passwordHash = await hashPassword(password);
    await runtime.database.transaction(tx => accountService.createAccount(tx,
      { email, passwordHash, displayName: 'Customer', role: 'customer' }));
    const commerce = new AuthService({ operatorMs: 60_000, customerMs: 600_000 }, COMMERCE_ROLES, {
      database: runtime.database,
      tokens: new IdentityTokenService(runtime.keyring!),
      mfa: runtime.mfa,
      mail: runtime.mail,
      publicUrl: 'http://localhost:3000',
      storeName: 'Base',
      locale: 'en',
    });
    const session = await commerce.authenticate(runtime.database.db, { email, password });
    expect((await commerce.resolveSession(runtime.database.db, session.token))?.actor.type).toBe('customer');
    expect(session.expiresAt.getTime() - Date.now()).toBeGreaterThan(590_000);

    await commerce.requestPasswordReset({ email, ttlMs: 3_600_000 });
    const mail = await runtime.database.pool.query<{ text_body: string }>(
      `SELECT text_body FROM public.platform_mail_messages ORDER BY created_at DESC LIMIT 1`);
    const token = decodeURIComponent(/token=([A-Za-z0-9._~%-]+)/.exec(mail.rows[0].text_body)![1]);

    await expect(runtime.auth.authenticate(runtime.database.db, { email, password }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED', message: 'Invalid email or password' });
    await expect(runtime.auth.resolveSession(runtime.database.db, session.token)).resolves.toBeNull();
    // Base policy 不認得 customer 角色，因此它連一個重設 token 都不會簽發。
    const before = await pendingTokens(email);
    await runtime.auth.requestPasswordReset({ email });
    expect(await pendingTokens(email)).toBe(before);
    await expect(runtime.auth.resetPassword({ token, newPassword: password }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await commerce.resetPassword({ token, newPassword: 'eight888' });
  });

  it('rejects issuing an API token for a role the release does not own or does not allow for tokens', async () => {
    // Base 的角色目錄裡沒有 "customer"（那是 Commerce 的角色）——release 決定它自己認得哪些角色。
    await expect(runtime.database.transaction(tx => runtime.apiTokens.issue(tx,
      { name: 'unused-customer-token', role: 'customer', ttlMs: 60_000 })))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('Unknown role') });
    // "member" 是 Base 認得的角色，但它是自助帳號、不是操作者，不能簽出 API token。
    await expect(runtime.database.transaction(tx => runtime.apiTokens.issue(tx,
      { name: 'unused-member-token', role: 'member', ttlMs: 60_000 })))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('cannot be used by an API token') });
  });
});
