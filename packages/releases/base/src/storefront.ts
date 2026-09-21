import { baseTheme, editorialTheme } from '@storeweave/theme-base';
import { resolveStorefrontProjection, type StorefrontProjectionFactory } from '@storeweave/release/storefront';
import { BASE_TARGET_KEYS, baseReleaseDefinition, validateBaseReleaseDefinition } from './definition';

export interface BaseStorefrontProjection {
  readonly themes: { readonly base: typeof baseTheme; readonly editorial: typeof editorialTheme };
}

export const baseStorefrontProjectionFactory: StorefrontProjectionFactory<BaseStorefrontProjection> & { readonly source: string } = {
  target: 'storefront', key: BASE_TARGET_KEYS.storefront, source: 'packages/releases/base/src/storefront.ts',
  resolve: () => ({ themes: { base: baseTheme, editorial: editorialTheme } }),
};

export function resolveBaseStorefrontProjection(): BaseStorefrontProjection;
export function resolveBaseStorefrontProjection<Contribution>(definition: unknown, factory: StorefrontProjectionFactory<Contribution>): Contribution;
export function resolveBaseStorefrontProjection<Contribution>(
  definition: unknown = baseReleaseDefinition,
  factory: StorefrontProjectionFactory<Contribution> = baseStorefrontProjectionFactory as unknown as StorefrontProjectionFactory<Contribution>,
): Contribution {
  return resolveStorefrontProjection(validateBaseReleaseDefinition(definition), factory);
}
