import { defaultTheme, editorialTheme } from '@storeweave/theme-default';
import { resolveStorefrontProjection, type StorefrontProjectionFactory } from '@storeweave/release/storefront';
import { COMMERCE_TARGET_KEYS, commerceFactoryList, commerceReleaseDefinition, requireCommerceProjectionFactory, validateCommerceReleaseDefinition, type CommerceProjectionFactoryInput } from './definition';

export interface CommerceStorefrontProjection {
  readonly themes: { readonly default: typeof defaultTheme; readonly editorial: typeof editorialTheme };
  readonly themeAssets: 'packages/themes/default/assets';
}
export const commerceStorefrontProjectionFactory: StorefrontProjectionFactory<CommerceStorefrontProjection> & { readonly source: string } = {
  target: 'storefront', key: COMMERCE_TARGET_KEYS.storefront, source: 'packages/releases/commerce/src/storefront.ts',
  resolve: () => ({ themes: { default: defaultTheme, editorial: editorialTheme }, themeAssets: 'packages/themes/default/assets' }),
};
export function resolveCommerceStorefrontProjection(): CommerceStorefrontProjection;
export function resolveCommerceStorefrontProjection<Contribution>(definition: unknown, factory: CommerceProjectionFactoryInput<StorefrontProjectionFactory<Contribution>>): Contribution;
export function resolveCommerceStorefrontProjection<Contribution>(definition: unknown = commerceReleaseDefinition, factory: CommerceProjectionFactoryInput<StorefrontProjectionFactory<Contribution>> = commerceStorefrontProjectionFactory as unknown as StorefrontProjectionFactory<Contribution>): Contribution {
  const validated = validateCommerceReleaseDefinition(definition);
  return resolveStorefrontProjection(validated, requireCommerceProjectionFactory('storefront', COMMERCE_TARGET_KEYS.storefront, commerceFactoryList(factory)));
}
