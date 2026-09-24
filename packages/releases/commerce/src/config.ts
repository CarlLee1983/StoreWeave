import { commerceConfigDefinition } from '@storeweave/config';
import { resolveConfigProjection, type ConfigProjectionFactory } from '@storeweave/release/config';
import { COMMERCE_TARGET_KEYS, commerceFactoryList, commerceReleaseDefinition, requireCommerceProjectionFactory, validateCommerceReleaseDefinition, type CommerceProjectionFactoryInput } from './definition';

export interface CommerceConfigProjection { readonly definition: typeof commerceConfigDefinition; readonly defaultFilename: 'commerce.yaml' }
export const commerceConfigProjectionFactory: ConfigProjectionFactory<CommerceConfigProjection> & { readonly source: string } = {
  target: 'config', key: COMMERCE_TARGET_KEYS.config, source: 'packages/releases/commerce/src/config.ts', resolve: () => ({ definition: commerceConfigDefinition, defaultFilename: 'commerce.yaml' }),
};
export function resolveCommerceConfigProjection(): CommerceConfigProjection;
export function resolveCommerceConfigProjection<Contribution>(definition: unknown, factory: CommerceProjectionFactoryInput<ConfigProjectionFactory<Contribution>>): Contribution;
export function resolveCommerceConfigProjection<Contribution>(definition: unknown = commerceReleaseDefinition, factory: CommerceProjectionFactoryInput<ConfigProjectionFactory<Contribution>> = commerceConfigProjectionFactory as unknown as ConfigProjectionFactory<Contribution>): Contribution {
  const validated = validateCommerceReleaseDefinition(definition);
  return resolveConfigProjection(validated, requireCommerceProjectionFactory('config', COMMERCE_TARGET_KEYS.config, commerceFactoryList(factory)));
}
