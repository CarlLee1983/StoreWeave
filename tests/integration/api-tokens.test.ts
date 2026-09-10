import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from './helpers';

const harnesses: TestHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.close()));
});

async function harness() {
  const created = await createHarness();
  harnesses.push(created);
  return created;
}

const issue = (h: TestHarness, name: string, role = 'staff', ttlMs = 60 * 60_000) =>
  h.runtime.database.transaction(tx => h.runtime.apiTokens.issue(tx, { name, role, ttlMs }));

describe('database-owned API tokens', () => {
  it('issues a secret exactly once and never stores it', async () => {
    const h = await harness();
    const issued = await issue(h, 'mcp-client', 'mcp');
    expect(issued.secret.startsWith(`swt1.${issued.id}.`)).toBe(true);

    const stored = await h.runtime.database.pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM platform_api_tokens WHERE id = $1', [issued.id]);
    expect(stored.rows[0].token_hash).not.toContain(issued.secret.split('.')[2]);

    const resolved = await h.runtime.apiTokens.resolve(h.runtime.database.db, issued.secret);
    expect(resolved).toMatchObject({ name: 'mcp-client', role: 'mcp' });
  });

  it('stops resolving the moment it is revoked', async () => {
    const h = await harness();
    const issued = await issue(h, 'revocable');
    expect(await h.runtime.apiTokens.resolve(h.runtime.database.db, issued.secret)).not.toBeNull();

    await h.runtime.database.transaction(tx => h.runtime.apiTokens.revoke(tx, 'revocable'));
    // 撤銷不必等快取或重啟：下一個請求就不通過。
    expect(await h.runtime.apiTokens.resolve(h.runtime.database.db, issued.secret)).toBeNull();
    await expect(h.runtime.database.transaction(tx => h.runtime.apiTokens.revoke(tx, 'revocable'))).rejects.toThrow();
  });

  it('stops resolving once it expires', async () => {
    const h = await harness();
    const issued = await issue(h, 'short-lived');
    await h.runtime.database.pool.query(
      `UPDATE platform_api_tokens SET expires_at = now() - interval '1 second' WHERE id = $1`, [issued.id]);
    expect(await h.runtime.apiTokens.resolve(h.runtime.database.db, issued.secret)).toBeNull();
  });

  it('refuses a role the release does not allow a token to hold', async () => {
    const h = await harness();
    // customer 的資料範圍由 Actor.type 決定；一個扮成顧客的 service token
    // 會變成「看得到全部訂單的顧客」。
    await expect(issue(h, 'impersonator', 'customer')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(issue(h, 'unknown-role', 'no-such-role')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses a duplicate name so every token stays revocable by name', async () => {
    const h = await harness();
    await issue(h, 'only-one');
    await expect(issue(h, 'only-one')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('lets a revoked name be reissued so rotation does not need a new name', async () => {
    const h = await harness();
    const first = await issue(h, 'mcp');
    await h.runtime.database.transaction(tx => h.runtime.apiTokens.revoke(tx, 'mcp'));

    // 輪替就是「撤掉舊的、用同一個名字發新的」。名字若被撤銷的列永久佔住，
    // 營運端只能發 mcp-2 再改掉每一份部署設定，於是輪替就不會發生（ADR 0043）。
    const second = await issue(h, 'mcp');
    expect(second.id).not.toBe(first.id);
    expect(await h.runtime.apiTokens.resolve(h.runtime.database.db, first.secret)).toBeNull();
    expect(await h.runtime.apiTokens.resolve(h.runtime.database.db, second.secret)).toMatchObject({ name: 'mcp' });

    // 撤銷仍然只認得還活著的那一把。
    await h.runtime.database.transaction(tx => h.runtime.apiTokens.revoke(tx, 'mcp'));
    expect(await h.runtime.apiTokens.resolve(h.runtime.database.db, second.secret)).toBeNull();
  });

  it('rejects a tampered secret, a wrong id and a malformed presentation', async () => {
    const h = await harness();
    const issued = await issue(h, 'tamper-target');
    const [prefix, id, secret] = issued.secret.split('.');

    const db = h.runtime.database.db;
    expect(await h.runtime.apiTokens.resolve(db, `${prefix}.${id}.${secret.slice(0, -2)}xy`)).toBeNull();
    expect(await h.runtime.apiTokens.resolve(db, `${prefix}.00000000-0000-4000-8000-000000000000.${secret}`)).toBeNull();
    expect(await h.runtime.apiTokens.resolve(db, secret)).toBeNull();
    expect(await h.runtime.apiTokens.resolve(db, `swt2.${id}.${secret}`)).toBeNull();
  });

  it('records last use so an unused token can be retired with evidence', async () => {
    const h = await harness();
    const issued = await issue(h, 'observed');
    expect((await h.runtime.apiTokens.list(h.runtime.database.db))
      .find(token => token.name === 'observed')?.lastUsedAt).toBeNull();

    await h.runtime.apiTokens.resolve(h.runtime.database.db, issued.secret);
    expect((await h.runtime.apiTokens.list(h.runtime.database.db))
      .find(token => token.name === 'observed')?.lastUsedAt).not.toBeNull();
  });
});
