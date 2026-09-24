import { release } from './runtime';
import { resolveWorkerProjection, type WorkerProjectionFactory } from '@storeweave/release/worker';
import { COMMERCE_TARGET_KEYS, commerceFactoryList, commerceReleaseDefinition, requireCommerceProjectionFactory, validateCommerceReleaseDefinition, type CommerceProjectionFactoryInput } from './definition';

export interface CommerceWorkerProjection { readonly target: 'worker'; readonly release: typeof release }
export const commerceWorkerProjectionFactory: WorkerProjectionFactory<CommerceWorkerProjection> = {
  target: 'worker', key: COMMERCE_TARGET_KEYS.worker, resolve: () => ({ target: 'worker', release }),
};
export function resolveCommerceWorkerProjection(): CommerceWorkerProjection;
export function resolveCommerceWorkerProjection<Contribution>(definition: unknown, factory: CommerceProjectionFactoryInput<WorkerProjectionFactory<Contribution>>): Contribution;
export function resolveCommerceWorkerProjection<Contribution>(definition: unknown = commerceReleaseDefinition, factory: CommerceProjectionFactoryInput<WorkerProjectionFactory<Contribution>> = commerceWorkerProjectionFactory as WorkerProjectionFactory<Contribution>): Contribution {
  const validated = validateCommerceReleaseDefinition(definition);
  return resolveWorkerProjection(validated, requireCommerceProjectionFactory('worker', COMMERCE_TARGET_KEYS.worker, commerceFactoryList(factory)));
}

export const workerProjection = resolveCommerceWorkerProjection();
