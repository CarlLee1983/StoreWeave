import { resolveCliProjection, type CliProjectionFactory, type CliReleaseIdentity } from '../../../platform/release/src/cli';
import { FILE_REQUESTS_TARGET_KEYS, fileRequestsReleaseDefinition, validateFileRequestsReleaseDefinition } from './definition';
import { release } from './runtime';
import { seed } from '../../../../scripts/seeds/file-requests';

export interface FileRequestsCliProjection {
  readonly release: typeof release;
  readonly seed: typeof seed;
  readonly identity: CliReleaseIdentity;
  readonly commands: { readonly declared: readonly []; readonly contributions: readonly [] };
}

export const fileRequestsCliProjectionFactory: CliProjectionFactory<FileRequestsCliProjection> = {
  target: 'cli', key: FILE_REQUESTS_TARGET_KEYS.cli,
  resolve: () => ({
    release,
    seed,
    identity: {
      compatibleReleaseIds: ['file-requests'], commandName: 'storeweave', servicePrefix: 'storeweave',
      filesystemName: 'storeweave', configFilename: 'storeweave.yaml',
    },
    commands: { declared: [], contributions: [] },
  }),
};

export function resolveFileRequestsCliProjection(): FileRequestsCliProjection {
  return resolveCliProjection(validateFileRequestsReleaseDefinition(fileRequestsReleaseDefinition), fileRequestsCliProjectionFactory);
}
export const cliProjection = resolveFileRequestsCliProjection();
