import { resolveWorkerProjection, type WorkerProjectionFactory } from '../../../platform/release/src/worker';
import { FILE_REQUESTS_TARGET_KEYS, fileRequestsReleaseDefinition, validateFileRequestsReleaseDefinition } from './definition';
import { release } from './runtime';

export interface FileRequestsWorkerProjection { readonly target: 'worker'; readonly release: typeof release }
export const fileRequestsWorkerProjectionFactory: WorkerProjectionFactory<FileRequestsWorkerProjection> = {
  target: 'worker', key: FILE_REQUESTS_TARGET_KEYS.worker, resolve: () => workerProjection,
};
export const workerProjection = { target: 'worker', release } as const;
export function resolveFileRequestsWorkerProjection() {
  return resolveWorkerProjection(validateFileRequestsReleaseDefinition(fileRequestsReleaseDefinition), fileRequestsWorkerProjectionFactory);
}
