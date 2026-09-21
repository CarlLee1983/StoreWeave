import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { LegacyContentMediaBackfill } from '@storeweave/content';
import type { Runtime } from '@storeweave/kernel';
import { WOVEN_DAY_LEGACY_MEDIA_MANIFEST } from '@storeweave/theme-default';
import { seed } from '../../../../scripts/seeds/commerce';
import { resolveCliProjection, type CliProjectionFactory } from '@storeweave/release/cli';
import { COMMERCE_TARGET_KEYS, commerceFactoryList, commerceReleaseDefinition, requireCommerceProjectionFactory, validateCommerceReleaseDefinition, type CommerceProjectionFactoryInput } from './definition';
import { resolveCommerceConfigProjection } from './config';
import { release } from './runtime';

export interface CommerceCliContext {
  readonly withRuntime: <T>(fn: (runtime: Runtime, configPath: string) => Promise<T>) => Promise<T>;
  readonly line: (message: string) => void;
  readonly fail: (message: string) => never;
}

export interface CommerceCliProjection {
  readonly release: typeof release;
  readonly seed: typeof seed;
  readonly identity: {
    readonly compatibleReleaseIds: readonly ['commerce'];
    readonly commandName: 'commerce';
    readonly servicePrefix: 'commerce';
    readonly filesystemName: 'commerce';
    readonly configFilename: string;
    readonly legacyEnvironmentPrefix: 'COMMERCE';
  };
  readonly legacyB01: { readonly releaseId: 'commerce'; readonly baselineId: 'legacy-commerce-0.1.0-pre-b02' };
  readonly commands: {
    readonly declared: readonly ['content:backfill-legacy-media'];
    readonly contributions: readonly {
      readonly name: 'content:backfill-legacy-media';
      readonly configure: (command: Command, context: CommerceCliContext) => void;
    }[];
  };
}

export const commerceCliProjectionFactory: CliProjectionFactory<CommerceCliProjection> = {
  target: 'cli', key: COMMERCE_TARGET_KEYS.cli, resolve: () => ({
    release,
    seed,
    identity: {
      compatibleReleaseIds: ['commerce'],
      commandName: 'commerce', servicePrefix: 'commerce', filesystemName: 'commerce', legacyEnvironmentPrefix: 'COMMERCE',
      configFilename: resolveCommerceConfigProjection().defaultFilename,
    },
    legacyB01: { releaseId: 'commerce', baselineId: 'legacy-commerce-0.1.0-pre-b02' },
    commands: {
      declared: ['content:backfill-legacy-media'],
      contributions: [{
        name: 'content:backfill-legacy-media',
        configure: (command, context) => {
          command
            .description('匯入預設 Theme 的舊文章圖片；可安全重跑，待 Worker 完成後再執行一次以附掛文章')
            .requiredOption('--assets-dir <path>', '含 woven-day-*.png 的已驗證 Theme assets 目錄')
            .action(async (options: { assetsDir: string }) => {
              const assetsDir = resolve(options.assetsDir);
              for (const entry of WOVEN_DAY_LEGACY_MEDIA_MANIFEST) {
                const asset = resolve(assetsDir, entry.file);
                if (!asset.startsWith(`${assetsDir}/`)) context.fail(`不安全的 Theme asset path：${entry.file}`);
              }
              await context.withRuntime(async runtime => {
                await runtime.activateRelease('require-current');
                const operation = new LegacyContentMediaBackfill(runtime.database, runtime.media, runtime.media.references, {
                  open: async entry => ({ stream: createReadStream(resolve(assetsDir, entry.file)), contentType: 'image/png' }),
                });
                const report = await operation.run(WOVEN_DAY_LEGACY_MEDIA_MANIFEST);
                const reconciliation = await operation.reconcile(WOVEN_DAY_LEGACY_MEDIA_MANIFEST);
                context.line(JSON.stringify({ report, reconciliation }, null, 2));
                if (report.failed.length || report.waiting || reconciliation.unmappedKeys.length || reconciliation.incompleteKeys.length) process.exitCode = 2;
              });
            });
        },
      }],
    },
  }),
};
export function resolveCommerceCliProjection(): CommerceCliProjection;
export function resolveCommerceCliProjection<Contribution>(definition: unknown, factory: CommerceProjectionFactoryInput<CliProjectionFactory<Contribution>>): Contribution;
export function resolveCommerceCliProjection<Contribution>(definition: unknown = commerceReleaseDefinition, factory: CommerceProjectionFactoryInput<CliProjectionFactory<Contribution>> = commerceCliProjectionFactory as CliProjectionFactory<Contribution>): Contribution {
  const validated = validateCommerceReleaseDefinition(definition);
  return resolveCliProjection(validated, requireCommerceProjectionFactory('cli', COMMERCE_TARGET_KEYS.cli, commerceFactoryList(factory)));
}

export const cliProjection = resolveCommerceCliProjection();
