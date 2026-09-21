import { resolve } from 'node:path';
import { build, type Plugin } from 'vite';
import { expect, it } from 'vitest';

const FORBIDDEN_MODULE_PATTERNS: readonly [string, RegExp][] = [
  ['API or worker implementation', /(?:^|\/)apps\/(?:api|worker)\//i],
  ['Nest implementation', /(?:^|\/)(?:@nestjs\/[^/]+|node_modules\/@nestjs\/[^/]+)(?:\/|$)/i],
  ['PostgreSQL or Drizzle implementation', /(?:^|\/)(?:pg|drizzle-orm)(?:\/|$)/i],
  ['Node runtime', /^node:|(?:^|\/)node:/i],
  ['database or persistence implementation', /(?:^|\/)[^/]*(?:database|persistence|db)[^/]*(?:\/|$)/i],
  ['migration implementation', /(?:^|\/)[^/]*migrations?[^/]*(?:\/|$)/i],
  ['secret implementation', /(?:^|\/)[^/]*secrets?[^/]*(?:\/|$)/i],
  ['provider implementation', /(?:^|\/)packages\/extensions(?:\/|$)|(?:^|\/)packages\/(?:[^/]+\/)*src\/(?:providers?\/|(?:payment|shipping|erp|invoice)-providers?\.[cm]?[jt]sx?$|provider-(?:impl(?:ementation)?|adapter)\.[cm]?[jt]sx?$)/i],
  ['workspace database package', /^@storeweave\/(?:db|database)(?:\/|$)/i],
];

function forbiddenModuleReason(id: string): string | undefined {
  return FORBIDDEN_MODULE_PATTERNS.find(([, pattern]) => pattern.test(id))?.[0];
}

it('recognizes every forbidden browser graph category, including file-based migrations and provider modules', () => {
  const forbidden = [
    '/repo/node_modules/@nestjs/core/index.js',
    'pg',
    '/repo/node_modules/drizzle-orm/index.js',
    'node:fs',
    '/repo/packages/platform/db/src/client.ts',
    '/repo/packages/commerce/order/src/migrations.ts',
    '/repo/packages/platform/config/src/secret.ts',
    '/repo/packages/extensions/ecpay/src/index.ts',
    '/repo/packages/payment/src/providers/ecpay.ts',
    '@storeweave/db',
  ];
  for (const id of forbidden) expect(forbiddenModuleReason(id), id).toBeTruthy();
  for (const id of [
    'react',
    '/repo/apps/admin/src/routes.tsx',
    '/repo/packages/platform/contracts/src/index.ts',
    '/repo/packages/platform/extension-sdk/src/providers.ts',
    '/repo/packages/ui/src/components/BookingAdminProvider.tsx',
  ]) {
    expect(forbiddenModuleReason(id), id).toBeUndefined();
  }
});

it('builds the selected Commerce Admin contribution without server or provider implementations', async () => {
  const moduleIds = new Set<string>();
  const forbiddenImports = new Set<string>();
  const captureModules: Plugin = {
    name: 'storeweave-admin-module-scan',
    resolveId(source) {
      if (forbiddenModuleReason(source)) forbiddenImports.add(source);
      return null;
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const id of Object.keys(output.modules)) moduleIds.add(id.replaceAll('\\', '/'));
      }
    },
  };

  await build({
    configFile: resolve('apps/admin/vite.config.ts'),
    plugins: [captureModules],
    logLevel: 'silent',
    build: { write: false, emptyOutDir: false },
  });

  const modules = [...moduleIds];
  expect(modules).toContain(resolve('packages/releases/commerce/src/admin.tsx').replaceAll('\\', '/'));
  expect(modules).not.toContain(resolve('scripts/validate-admin-projection.ts').replaceAll('\\', '/'));
  expect(modules).not.toContain(resolve('packages/platform/release/src/runtime.ts').replaceAll('\\', '/'));
  expect(modules.filter(forbiddenModuleReason)).toEqual([]);
  expect([...forbiddenImports]).toEqual([]);
}, 15_000);
