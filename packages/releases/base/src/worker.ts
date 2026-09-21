import { release } from './runtime';
import { resolveWorkerProjection, type WorkerProjectionFactory } from '@storeweave/release/worker';
import { BASE_TARGET_KEYS, baseReleaseDefinition, validateBaseReleaseDefinition } from './definition';

export interface BaseWorkerProjection { readonly target: 'worker'; readonly release: typeof release }

export const baseWorkerProjectionFactory: WorkerProjectionFactory<BaseWorkerProjection> = {
  target: 'worker', key: BASE_TARGET_KEYS.worker, resolve: () => ({ target: 'worker', release }),
};

export function resolveBaseWorkerProjection(): BaseWorkerProjection;
export function resolveBaseWorkerProjection<Contribution>(definition: unknown, factory: WorkerProjectionFactory<Contribution>): Contribution;
export function resolveBaseWorkerProjection<Contribution>(
  definition: unknown = baseReleaseDefinition,
  factory: WorkerProjectionFactory<Contribution> = baseWorkerProjectionFactory as WorkerProjectionFactory<Contribution>,
): Contribution {
  return resolveWorkerProjection(validateBaseReleaseDefinition(definition), factory);
}

export const workerProjection = resolveBaseWorkerProjection();
