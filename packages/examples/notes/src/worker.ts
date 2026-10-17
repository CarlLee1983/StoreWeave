import { release } from './runtime';
import { resolveWorkerProjection, type WorkerProjectionFactory } from '@storeweave/release/worker';
import { NOTES_TARGET_KEYS, notesReleaseDefinition, validateNotesReleaseDefinition } from './definition';

export interface NotesWorkerProjection { readonly target: 'worker'; readonly release: typeof release }

export const notesWorkerProjectionFactory: WorkerProjectionFactory<NotesWorkerProjection> = {
  target: 'worker', key: NOTES_TARGET_KEYS.worker, resolve: () => ({ target: 'worker', release }),
};

export function resolveNotesWorkerProjection(): NotesWorkerProjection;
export function resolveNotesWorkerProjection<Contribution>(definition: unknown, factory: WorkerProjectionFactory<Contribution>): Contribution;
export function resolveNotesWorkerProjection<Contribution>(
  definition: unknown = notesReleaseDefinition,
  factory: WorkerProjectionFactory<Contribution> = notesWorkerProjectionFactory as WorkerProjectionFactory<Contribution>,
): Contribution {
  return resolveWorkerProjection(validateNotesReleaseDefinition(definition), factory);
}

export const workerProjection = resolveNotesWorkerProjection();
