import { httpAdapter } from '../../../../apps/api/src/releases/commerce';
import { release } from './runtime';
import { resolveServerProjection, type ServerProjectionFactory } from '@storeweave/release/server';
import { COMMERCE_TARGET_KEYS, commerceFactoryList, commerceReleaseDefinition, requireCommerceProjectionFactory, validateCommerceReleaseDefinition, type CommerceProjectionFactoryInput } from './definition';

export interface CommerceServerProjection { readonly release: typeof release; readonly httpAdapter: typeof httpAdapter }
export const commerceServerProjectionFactory: ServerProjectionFactory<CommerceServerProjection> = {
  target: 'server', key: COMMERCE_TARGET_KEYS.server, resolve: () => ({ release, httpAdapter }),
};
export function resolveCommerceServerProjection(): CommerceServerProjection;
export function resolveCommerceServerProjection<Contribution>(definition: unknown, factory: CommerceProjectionFactoryInput<ServerProjectionFactory<Contribution>>): Contribution;
export function resolveCommerceServerProjection<Contribution>(definition: unknown = commerceReleaseDefinition, factory: CommerceProjectionFactoryInput<ServerProjectionFactory<Contribution>> = commerceServerProjectionFactory as ServerProjectionFactory<Contribution>): Contribution {
  const validated = validateCommerceReleaseDefinition(definition);
  return resolveServerProjection(validated, requireCommerceProjectionFactory('server', COMMERCE_TARGET_KEYS.server, commerceFactoryList(factory)));
}

export const serverProjection = resolveCommerceServerProjection();
