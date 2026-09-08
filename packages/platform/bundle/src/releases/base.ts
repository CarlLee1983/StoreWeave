import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigDefinition, type BaseConfig } from '@storeweave/config';
import { PLATFORM_VERSION } from '@storeweave/contracts';
import packageJson from '../../package.json';
import type { ReleaseDefinition } from '../release';

export const release: ReleaseDefinition<BaseConfig> = {
  id: 'base', version: process.env.STOREWEAVE_RELEASE_VERSION ?? packageJson.version, baseVersion: PLATFORM_VERSION,
  config: baseConfigDefinition, roles: BASE_ROLES, legacyBaselines: [],
  manifestConfig: { version: 1, store: { id: 'build-only', name: 'Build only' }, database: { url: 'postgres://manifest.invalid/unused' } },
  createModules: () => [],
  availableExtensions: {}, availableThemes: {},
};
