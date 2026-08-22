import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const patterns = [/from\s+['"]([^'"]+)['"]/g, /require\(\s*['"]([^'"]+)['"]\s*\)/g, /import\(\s*['"]([^'"]+)['"]\s*\)/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

/** Extension 只能倚賴公開契約，不能碰資料層。 */
const FORBIDDEN_FOR_EXTENSIONS = [
  '@storeweave/db',
  '@storeweave/kernel',
  '@storeweave/catalog',
  '@storeweave/inventory',
  '@storeweave/order',
  '@storeweave/command-bus',
  '@storeweave/query-bus',
  '@storeweave/outbox',
  '@storeweave/jobs',
  'drizzle-orm',
  'pg',
];

describe('Extension 邊界', () => {
  const files = sourceFiles('packages/extensions').filter((f) => !f.includes('/test/'));

  it('掃描到 Extension 原始碼', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => relative(ROOT, f)))('%s 沒有 import 資料層或其他模組', (relativePath) => {
    const violations = importsOf(join(ROOT, relativePath)).filter((spec) =>
      FORBIDDEN_FOR_EXTENSIONS.some((forbidden) => spec === forbidden || spec.startsWith(`${forbidden}/`)),
    );
    expect(violations).toEqual([]);
  });

  it('Extension 只透過 @storeweave/extension-sdk 與 @storeweave/contracts 接入平台', () => {
    const allowed = new Set(['@storeweave/extension-sdk', '@storeweave/contracts', 'zod', 'semver']);
    const external = new Set<string>();
    for (const file of files) {
      for (const spec of importsOf(file)) {
        if (spec.startsWith('.') || spec.startsWith('node:')) continue;
        if (!allowed.has(spec)) external.add(spec);
      }
    }
    expect([...external]).toEqual([]);
  });
});

describe('MCP 不得繞過 Application Layer', () => {
  const mcpFiles = [
    ...sourceFiles('packages/extensions/mcp'),
    ...sourceFiles('apps/api/src/mcp'),
  ];

  it.each(mcpFiles.map((f) => relative(ROOT, f)))('%s 不接觸資料庫或 repository', (relativePath) => {
    const full = join(ROOT, relativePath);
    const specs = importsOf(full);
    const source = readFileSync(full, 'utf8');

    expect(specs.filter((s) => s === 'pg' || s === 'drizzle-orm' || s.startsWith('drizzle-orm/'))).toEqual([]);
    expect(specs.filter((s) => s === '@storeweave/db')).toEqual([]);
    expect(specs.filter((s) => /repository/i.test(s))).toEqual([]);
    expect(source).not.toMatch(/\bruntime\.database\b/);
    expect(source).not.toMatch(/\bSELECT\s+.*\bFROM\b/i);
  });

  it('MCP 工具只能指向 command 或 query', async () => {
    const { ALL_MCP_TOOLS } = await import('@storeweave/ext-mcp');
    expect(ALL_MCP_TOOLS.length).toBeGreaterThan(0);
    for (const tool of ALL_MCP_TOOLS) {
      expect(['command', 'query']).toContain(tool.target.kind);
      expect(tool.target.name).toMatch(/^commerce\./);
    }
  });

  it('MCP 的每個工具目標都真的註冊在 Bus 上', async () => {
    const { ALL_MCP_TOOLS } = await import('@storeweave/ext-mcp');
    const { coreModules } = await import('@storeweave/bundle');
    const modules = coreModules({ providers: { list: () => [] } as never, defaultCurrency: 'TWD', orderNumberPrefix: 'SW', timezone: 'Asia/Taipei', locale: 'zh-TW' });
    const commandNames = modules.flatMap((m) => (m.commands ?? []).map((c) => c.descriptor.name));
    const queryNames = modules.flatMap((m) => (m.queries ?? []).map((q) => q.descriptor.name));
    for (const tool of ALL_MCP_TOOLS) {
      const pool = tool.target.kind === 'command' ? commandNames : queryNames;
      expect(pool).toContain(tool.target.name);
    }
    // 這條測試會動態載入整個 bundle 的模組圖，冷啟動比預設的 5 秒久。
  }, 30_000);
});

describe('Commerce Core 沒有客戶條件判斷', () => {
  const coreFiles = sourceFiles('packages/commerce').concat(sourceFiles('packages/platform'));

  it('不出現客戶名稱或針對客戶的分支', () => {
    const customerNames = ['aurora', 'acme', 'example-store'];
    const offenders: string[] = [];
    for (const file of coreFiles) {
      if (file.includes('/test/')) continue;
      const source = readFileSync(file, 'utf8').toLowerCase();
      if (/if\s*\(\s*(customer|tenant|store)(id)?\s*===/.test(source)) offenders.push(`${relative(ROOT, file)}: customer branch`);
      for (const name of customerNames) {
        if (source.includes(`'${name}'`) || source.includes(`"${name}"`)) {
          offenders.push(`${relative(ROOT, file)}: hard-coded "${name}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('公開契約不外洩 ORM Entity', () => {
  it('Extension SDK 不匯出資料庫型別', () => {
    const sdk = readFileSync(join(ROOT, 'packages/platform/extension-sdk/src/index.ts'), 'utf8');
    expect(sdk).not.toMatch(/DrizzleDb|\bTx\b/);
    for (const spec of importsOf(join(ROOT, 'packages/platform/extension-sdk/src/context.ts'))) {
      expect(spec).not.toBe('@storeweave/db');
      expect(spec).not.toBe('drizzle-orm');
    }
  });

  it('每個 Command / Query 的 input 與 output 都是 Zod schema', async () => {
    const { coreModules } = await import('@storeweave/bundle');
    const modules = coreModules({ providers: { list: () => [] } as never, defaultCurrency: 'TWD', orderNumberPrefix: 'SW', timezone: 'Asia/Taipei', locale: 'zh-TW' });
    for (const mod of modules) {
      for (const { descriptor } of [...(mod.commands ?? []), ...(mod.queries ?? [])]) {
        expect(typeof descriptor.input.safeParse).toBe('function');
        expect(typeof descriptor.output.safeParse).toBe('function');
        expect(descriptor.permission).toMatch(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/);
      }
    }
  }, 30_000);
});
