import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `--json` 的輸出要餵得進程式（工單 24 的盤點就是被這件事卡住的）。
 *
 * runtime 的日誌預設寫 stdout，CLI 自己的輸出也寫 stdout，兩者混在一起之後
 * `commerce extension:list --json | jq` 會直接死在第一行 log 上。診斷訊息屬於 stderr，
 * 指令的答案才屬於 stdout——這條測試守的是這件事，不是日誌有沒有被關掉。
 */
const ROOT = process.cwd();

function runCli(args: string[]) {
  return spawnSync(join(ROOT, 'node_modules/.bin/tsx'), [join(ROOT, 'tools/cli/src/main.ts'), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    env: {
      ...process.env,
      COMMERCE_CONFIG: join(ROOT, 'deployments/example-store/commerce.yaml'),
      // 這些指令不連資料庫，但設定的必填機密還是要在。
      DATABASE_URL: 'postgres://commerce:devpw@127.0.0.1:5432/commerce',
      COMMERCE_ADMIN_TOKEN: 'test-admin-token-0123456789',
      COMMERCE_MCP_TOKEN: 'test-mcp-token-0123456789',
      DEMO_ERP_API_KEY: 'test-erp-key',
    },
  });
}

describe('commerce extension:list --json', () => {
  it('stdout 是一份乾淨的 JSON，日誌走 stderr', () => {
    const result = runCli(['extension:list', '--json']);
    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.items.map((i: { id: string }) => i.id)).toContain('demo-erp');

    // 日誌沒有被關掉，只是換了一條管線——人在終端機跑的時候還是看得到。
    expect(result.stderr).toContain('extension mounted');
  }, 60_000);
});
