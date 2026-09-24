import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const releases = {
  base: {
    runtime: 'packages/releases/base/src/runtime.ts',
    cli: 'packages/releases/base/src/cli.ts',
  },
  commerce: {
    runtime: 'packages/releases/commerce/src/runtime.ts',
    cli: 'packages/releases/commerce/src/cli.ts',
  },
  'file-requests': {
    runtime: 'packages/examples/file-requests/src/runtime.ts',
    cli: 'packages/examples/file-requests/src/cli.ts',
  },
} as const;

const forbiddenTargetSource = /(?:^|\/)apps\/(?:admin|api|worker)\//i;
const forbiddenProjection = /(?:^|\/)packages\/(?:releases\/[^/]+\/src\/(?:admin|server|worker)|platform\/release\/src\/(?:admin|server))\.[cm]?[jt]sx?$/i;
const forbiddenReact = /(?:^|\/)(?:react|react-dom)(?:\/|$)/i;

async function buildCli(releaseId: keyof typeof releases, outfile?: string) {
  const selection = releases[releaseId];
  return build({
    entryPoints: [resolve('tools/cli/src/main.ts')],
    bundle: true,
    write: outfile !== undefined,
    ...(outfile ? { outfile } : {}),
    metafile: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    tsconfig: resolve('tsconfig.json'),
    external: ['pg-native'],
    alias: {
      '@storeweave/selected-runtime': resolve(selection.runtime),
      '@storeweave/selected-cli': resolve(selection.cli),
    },
    logLevel: 'silent',
  });
}

it('selects each release CLI contribution without importing browser or other target code', async () => {
  const output = mkdtempSync(join(tmpdir(), 'storeweave-cli-projection-'));
  try {
    for (const releaseId of ['base', 'commerce', 'file-requests'] as const) {
      const outfile = join(output, `${releaseId}.cjs`);
      const result = await buildCli(releaseId, outfile);
      const inputs = new Set(Object.keys(result.metafile!.inputs).map(input => input.replaceAll('\\', '/')));
      const forbidden = [...inputs].filter(input =>
        forbiddenTargetSource.test(input) || forbiddenProjection.test(input) || forbiddenReact.test(input));
      expect(forbidden, `${releaseId} CLI forbidden inputs`).toEqual([]);
      expect(inputs).toContain(releaseId === 'file-requests'
        ? 'packages/examples/file-requests/src/cli.ts'
        : `packages/releases/${releaseId}/src/cli.ts`);
      if (releaseId === 'base' || releaseId === 'file-requests') {
        expect([...inputs].filter(input => input.includes('packages/releases/commerce/src/legacy-commerce-pre-b02.json'))).toEqual([]);
      }

      const help = execFileSync(process.execPath, [outfile, '--help'], { encoding: 'utf8' });
      expect(help).toContain(`Usage: ${releaseId === 'commerce' ? 'commerce' : 'storeweave'} `);
      expect(help.includes('content:backfill-legacy-media')).toBe(releaseId === 'commerce');
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
