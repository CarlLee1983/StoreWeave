import { resolveAdminProjection, type AdminProjectionFactory } from '../../../platform/release/src/admin';
import { FILE_REQUESTS_TARGET_KEYS, fileRequestsReleaseDefinition, validateFileRequestsReleaseDefinition } from './definition';

export interface FileRequestsAdminProjection { readonly enabled: false; readonly contributions: readonly [] }
export const fileRequestsAdminProjectionFactory: AdminProjectionFactory<FileRequestsAdminProjection> = {
  target: 'admin', key: FILE_REQUESTS_TARGET_KEYS.admin, resolve: () => ({ enabled: false, contributions: [] }),
};
export function resolveFileRequestsAdminProjection() {
  return resolveAdminProjection(validateFileRequestsReleaseDefinition(fileRequestsReleaseDefinition), fileRequestsAdminProjectionFactory);
}
