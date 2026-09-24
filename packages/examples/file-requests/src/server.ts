import { httpAdapter } from '../../../../apps/api/src/releases/file-requests';
import { resolveServerProjection, type ServerProjectionFactory } from '../../../platform/release/src/server';
import { FILE_REQUESTS_TARGET_KEYS, fileRequestsReleaseDefinition, validateFileRequestsReleaseDefinition } from './definition';
import { release } from './runtime';

export interface FileRequestsServerProjection { readonly release: typeof release; readonly httpAdapter: typeof httpAdapter }
export const fileRequestsServerProjectionFactory: ServerProjectionFactory<FileRequestsServerProjection> = {
  target: 'server', key: FILE_REQUESTS_TARGET_KEYS.server, resolve: () => ({ release, httpAdapter }),
};
export function resolveFileRequestsServerProjection() {
  return resolveServerProjection(validateFileRequestsReleaseDefinition(fileRequestsReleaseDefinition), fileRequestsServerProjectionFactory);
}
export const serverProjection = resolveFileRequestsServerProjection();
