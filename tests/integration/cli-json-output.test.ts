import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createTestDatabase } from './helpers';

/**
 * `--json` 的輸出要餵得進程式（工單 24 的盤點就是被這件事卡住的）。
 *
 * runtime 的日誌預設寫 stdout，CLI 自己的輸出也寫 stdout，兩者混在一起之後
 * `commerce extension:list --json | jq` 會直接死在第一行 log 上。診斷訊息屬於 stderr，
 * 指令的答案才屬於 stdout——這條測試守的是這件事，不是日誌有沒有被關掉。
 */
const ROOT = process.cwd();

function runCli(databaseUrl: string, args: string[]) {
  return spawnSync(join(ROOT, 'node_modules/.bin/tsx'), [join(ROOT, 'tools/cli/src/main.ts'), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    env: {
      ...process.env,
      COMMERCE_CONFIG: join(ROOT, 'deployments/example-store/commerce.yaml'),
      DATABASE_URL: databaseUrl,
      COMMERCE_ADMIN_TOKEN: 'test-admin-token-0123456789',
      COMMERCE_MCP_TOKEN: 'test-mcp-token-0123456789',
      DEMO_ERP_API_KEY: 'test-erp-key',
      COMMERCE_SIGNING_KEY_K1: Buffer.alloc(32, 3).toString('base64url'),
    },
  });
}

describe('commerce extension:list --json', () => {
  it('stdout 是一份乾淨的 JSON，日誌走 stderr', async () => {
    const databaseUrl = await createTestDatabase();
    const migrated = runCli(databaseUrl, ['migrate']);
    expect(migrated.status, migrated.stderr).toBe(0);
    const result = runCli(databaseUrl, ['extension:list', '--json']);
    expect(result.status, result.stderr).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.items.map((i: { id: string }) => i.id)).toContain('demo-erp');

    // 日誌沒有被關掉，只是換了一條管線——人在終端機跑的時候還是看得到。
    expect(result.stderr).toContain('extension mounted');
  }, 60_000);
});

it('migrate --status --json reports activation without applying SQL or mounting extensions', async () => {
  const databaseUrl = await createTestDatabase();
  const pending = runCli(databaseUrl, ['migrate', '--status', '--json']);
  expect(pending.status, pending.stderr).toBe(0);
  expect(JSON.parse(pending.stdout)).toMatchObject({ releaseCurrent: false, applied: [] });
  expect(JSON.parse(pending.stdout).pending).toHaveLength(63);
  expect(pending.stderr).not.toContain('extension mounted');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    expect((await client.query("SELECT to_regclass('public.platform_users') AS users")).rows).toEqual([{ users: null }]);
    expect((await client.query('SELECT count(*)::int AS count FROM platform_release_history')).rows).toEqual([{ count: 0 }]);
    const invalid = runCli(databaseUrl, ['migrate', '--json']);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('--json requires --status');
    expect((await client.query("SELECT to_regclass('public.platform_users') AS users")).rows).toEqual([{ users: null }]);
    const migrated = runCli(databaseUrl, ['migrate']);
    expect(migrated.status, migrated.stderr).toBe(0);
    const current = runCli(databaseUrl, ['migrate', '--status', '--json']);
    expect(current.status, current.stderr).toBe(0);
    expect(JSON.parse(current.stdout)).toMatchObject({ releaseCurrent: true, pending: [] });
    expect(current.stderr).not.toContain('extension mounted');
    expect((await client.query('SELECT count(*)::int AS count FROM platform_release_history')).rows).toEqual([{ count: 1 }]);
  } finally { await client.end(); }
}, 60_000);
