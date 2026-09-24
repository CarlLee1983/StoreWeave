import { baseConfigDefinition } from '@storeweave/config';
import { resolveConfigProjection, type ConfigProjectionFactory } from '@storeweave/release/config';
import { BASE_TARGET_KEYS, baseReleaseDefinition, validateBaseReleaseDefinition } from './definition';

export interface BaseConfigProjection {
  readonly definition: typeof baseConfigDefinition;
  readonly defaultFilename: 'storeweave.yaml';
}

export const baseConfigProjectionFactory: ConfigProjectionFactory<BaseConfigProjection> & { readonly source: string } = {
  target: 'config', key: BASE_TARGET_KEYS.config, source: 'packages/releases/base/src/config.ts',
  resolve: () => ({ definition: baseConfigDefinition, defaultFilename: 'storeweave.yaml' }),
};

export function resolveBaseConfigProjection(): BaseConfigProjection;
export function resolveBaseConfigProjection<Contribution>(definition: unknown, factory: ConfigProjectionFactory<Contribution>): Contribution;
export function resolveBaseConfigProjection<Contribution>(
  definition: unknown = baseReleaseDefinition,
  factory: ConfigProjectionFactory<Contribution> = baseConfigProjectionFactory as unknown as ConfigProjectionFactory<Contribution>,
): Contribution {
  return resolveConfigProjection(validateBaseReleaseDefinition(definition), factory);
}
