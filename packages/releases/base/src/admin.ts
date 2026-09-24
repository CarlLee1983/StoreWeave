import { resolveAdminProjection, type AdminProjectionFactory } from '@storeweave/release/admin';
import { BASE_TARGET_KEYS, baseReleaseDefinition, validateBaseReleaseDefinition } from './definition';

/** Base intentionally has no browser-admin contribution. */
export interface BaseAdminProjection { readonly enabled: false; readonly contributions: readonly [] }

export const baseAdminProjectionFactory: AdminProjectionFactory<BaseAdminProjection> = {
  target: 'admin', key: BASE_TARGET_KEYS.admin, resolve: () => ({ enabled: false, contributions: [] }),
};

export function resolveBaseAdminProjection(): BaseAdminProjection;
export function resolveBaseAdminProjection<Contribution>(definition: unknown, factory: AdminProjectionFactory<Contribution>): Contribution;
export function resolveBaseAdminProjection<Contribution>(
  definition: unknown = baseReleaseDefinition,
  factory: AdminProjectionFactory<Contribution> = baseAdminProjectionFactory as AdminProjectionFactory<Contribution>,
): Contribution {
  return resolveAdminProjection(validateBaseReleaseDefinition(definition), factory);
}
