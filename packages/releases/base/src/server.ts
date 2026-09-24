import { httpAdapter } from '../../../../apps/api/src/releases/base';
import { release } from './runtime';
import { resolveServerProjection, type ServerProjectionFactory } from '@storeweave/release/server';
import { BASE_TARGET_KEYS, baseReleaseDefinition, validateBaseReleaseDefinition } from './definition';

export interface BaseServerProjection {
  readonly release: typeof release;
  readonly httpAdapter: typeof httpAdapter;
}

export const baseServerProjectionFactory: ServerProjectionFactory<BaseServerProjection> = {
  target: 'server',
  key: BASE_TARGET_KEYS.server,
  resolve: () => ({ release, httpAdapter }),
};

export function resolveBaseServerProjection(): BaseServerProjection;
export function resolveBaseServerProjection<Contribution>(definition: unknown, factory: ServerProjectionFactory<Contribution>): Contribution;
export function resolveBaseServerProjection<Contribution>(
  definition: unknown = baseReleaseDefinition,
  factory: ServerProjectionFactory<Contribution> = baseServerProjectionFactory as ServerProjectionFactory<Contribution>,
): Contribution {
  return resolveServerProjection(validateBaseReleaseDefinition(definition), factory);
}

export const serverProjection = resolveBaseServerProjection();
