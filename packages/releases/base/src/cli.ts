import { resolveCliProjection, type CliProjectionFactory } from '@storeweave/release/cli';
import { resolveBaseConfigProjection } from './config';
import { seed } from '../../../../scripts/seeds/base';
import { BASE_TARGET_KEYS, baseReleaseDefinition, validateBaseReleaseDefinition } from './definition';
import { release } from './runtime';

export interface BaseCliProjection {
  readonly release: typeof release;
  readonly seed: typeof seed;
  readonly identity: {
    readonly compatibleReleaseIds: readonly ['base', 'file-requests'];
    readonly commandName: 'storeweave';
    readonly servicePrefix: 'storeweave';
    readonly filesystemName: 'storeweave';
    readonly configFilename: string;
  };
  readonly commands: { readonly declared: readonly []; readonly contributions: readonly [] };
}

export const baseCliProjectionFactory: CliProjectionFactory<BaseCliProjection> = {
  target: 'cli', key: BASE_TARGET_KEYS.cli, resolve: () => ({
    release,
    seed,
    identity: {
      compatibleReleaseIds: ['base', 'file-requests'],
      commandName: 'storeweave', servicePrefix: 'storeweave', filesystemName: 'storeweave',
      configFilename: resolveBaseConfigProjection().defaultFilename,
    },
    commands: { declared: [], contributions: [] },
  }),
};

export function resolveBaseCliProjection(): BaseCliProjection;
export function resolveBaseCliProjection<Contribution>(definition: unknown, factory: CliProjectionFactory<Contribution>): Contribution;
export function resolveBaseCliProjection<Contribution>(
  definition: unknown = baseReleaseDefinition,
  factory: CliProjectionFactory<Contribution> = baseCliProjectionFactory as CliProjectionFactory<Contribution>,
): Contribution {
  return resolveCliProjection(validateBaseReleaseDefinition(definition), factory);
}

export const cliProjection = resolveBaseCliProjection();
