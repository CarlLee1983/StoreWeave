import { PLATFORM_VERSION } from '@storeweave/contracts';
import { validateReleaseDefinition, type ReleaseDefinition, type ReleaseTarget } from '@storeweave/release';

export const FILE_REQUESTS_TARGET_KEYS = {
  server: 'file-requests.server.v1',
  worker: 'file-requests.worker.v1',
  admin: 'file-requests.admin.v1',
  cli: 'file-requests.cli.v1',
  config: 'file-requests.config.v1',
  storefront: 'file-requests.storefront.v1',
} as const satisfies Record<ReleaseTarget, string>;

const selected = {
  modules: ['platform-site', 'content', 'platform-auth', 'file-requests'],
  themes: ['base', 'editorial'],
  extensions: [],
} as const;

/** Serializable root manifest for the supported non-commerce module example. */
export const fileRequestsReleaseDefinition: ReleaseDefinition = {
  manifest: {
    id: 'file-requests',
    version: process.env.STOREWEAVE_RELEASE_VERSION ?? '0.1.0',
    selected,
    targets: Object.fromEntries(
      (Object.keys(FILE_REQUESTS_TARGET_KEYS) as ReleaseTarget[]).map(target => [target, { key: FILE_REQUESTS_TARGET_KEYS[target] }]),
    ) as ReleaseDefinition['manifest']['targets'],
    metadata: { baseVersion: PLATFORM_VERSION },
  },
};

export function validateFileRequestsReleaseDefinition(definition: unknown): ReleaseDefinition {
  const validated = validateReleaseDefinition(definition);
  if (validated.manifest.id !== 'file-requests') throw new Error('Invalid file-requests ReleaseDefinition id');
  for (const target of Object.keys(FILE_REQUESTS_TARGET_KEYS) as ReleaseTarget[]) {
    if (validated.manifest.targets[target].key !== FILE_REQUESTS_TARGET_KEYS[target]) {
      throw new Error(`Invalid file-requests ${target} target key`);
    }
  }
  if (JSON.stringify(validated.manifest.selected) !== JSON.stringify(selected)) {
    throw new Error('Invalid file-requests module/theme/extension selection');
  }
  return validated;
}
