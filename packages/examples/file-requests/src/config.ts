import { baseConfigDefinition } from '@storeweave/config';
import { resolveConfigProjection, type ConfigProjectionFactory } from '../../../platform/release/src/config';
import { FILE_REQUESTS_TARGET_KEYS, fileRequestsReleaseDefinition, validateFileRequestsReleaseDefinition } from './definition';

export const fileRequestsConfigProjectionFactory: ConfigProjectionFactory<{ readonly definition: typeof baseConfigDefinition; readonly defaultFilename: 'storeweave.yaml' }> & { readonly source: string } = {
  target: 'config', key: FILE_REQUESTS_TARGET_KEYS.config, source: 'packages/examples/file-requests/src/config.ts',
  resolve: () => ({ definition: baseConfigDefinition, defaultFilename: 'storeweave.yaml' }),
};
export function resolveFileRequestsConfigProjection() {
  return resolveConfigProjection(validateFileRequestsReleaseDefinition(fileRequestsReleaseDefinition), fileRequestsConfigProjectionFactory);
}
