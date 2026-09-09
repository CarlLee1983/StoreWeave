import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_ROLES, COMMERCE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger } from '@storeweave/contracts';
import { AuthService, accountService } from '@storeweave/identity';
import { createRuntime, type Runtime } from '@storeweave/kernel';
import { ADMIN_ACTOR, createTestDatabase, testSecretProvider } from './helpers';

let runtime: Runtime;
const password = 'release-role-passphrase';
beforeAll(async () => {
  runtime = await createRuntime({
    release: { id: 'test', version: '1.0.0', buildManifestChecksum: `sha256:${'0'.repeat(64)}` },
    roles: BASE_ROLES, config: baseConfigSchema.parse({
      version: 1, store: { id: 'base-test', name: 'Base' }, database: { url: await createTestDatabase() },
    }),
    secrets: testSecretProvider({}), logger: noopLogger, modules: [], availableExtensions: {},
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
    expect(session?.actor).toMatchObject({ type: 'user', permissions: ['users:read', 'jobs:read', 'storage:read'] });
    expect(runtime.actorForRole('staff').permissions).not.toContain('order:read');
    for (const role of ['customer', 'storefront', 'mcp', 'constructor']) {
      expect(() => runtime.actorForRole(role)).toThrow('Unknown role');
      await expect(create(role)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });

  it('a legacy customer cannot authenticate, resolve, or reset through Base policy', async () => {
    const email = `${randomUUID()}@example.com`;
    await runtime.database.transaction(tx => accountService.createAccount(tx,
      { email, password, displayName: 'Customer', role: 'customer' }));
    const commerce = new AuthService({ operatorMs: 60_000, customerMs: 600_000 }, COMMERCE_ROLES);
    const session = await commerce.authenticate(runtime.database.db, { email, password });
    expect((await commerce.resolveSession(runtime.database.db, session.token))?.actor.type).toBe('customer');
    expect(session.expiresAt.getTime() - Date.now()).toBeGreaterThan(590_000);
    const reset = await commerce.createPasswordReset(runtime.database.db, { email, ttlMs: 3_600_000 });
    expect(reset).not.toBeNull();
    await expect(runtime.auth.authenticate(runtime.database.db, { email, password }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED', message: 'Invalid email or password' });
    await expect(runtime.auth.resolveSession(runtime.database.db, session.token)).resolves.toBeNull();
    await expect(runtime.auth.createPasswordReset(runtime.database.db, { email, ttlMs: 60_000 })).resolves.toBeNull();
    await expect(runtime.auth.resetPassword(runtime.database.db, { token: reset!.token, newPassword: password }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await commerce.resetPassword(runtime.database.db, { token: reset!.token, newPassword: 'eight888' });
  });

  it('rejects token roles absent from the release before constructing the database', async () => {
    const config = baseConfigSchema.parse({
      version: 1, store: { id: 'base-test', name: 'Base' }, database: { url: 'postgres://invalid.invalid/test' },
    });
    config.auth.tokens = [{ name: 'mcp', role: 'mcp', secretRef: 'UNUSED_TOKEN' }];
    Object.defineProperty(config, 'database', { get: () => { throw new Error('database accessed'); } });
    await expect(createRuntime({
    release: { id: 'test', version: '1.0.0', buildManifestChecksum: `sha256:${'0'.repeat(64)}` },
      roles: BASE_ROLES, config, secrets: testSecretProvider({}), logger: noopLogger,
      modules: [], availableExtensions: {},
    })).rejects.toThrow('cannot be used by an API token');
  });
});
