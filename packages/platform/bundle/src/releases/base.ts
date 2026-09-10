import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigDefinition, type BaseConfig } from '@storeweave/config';
import { PLATFORM_VERSION } from '@storeweave/contracts';
import { baseTheme } from '@storeweave/theme-base';
import { createSiteModule } from '@storeweave/site';
import packageJson from '../../package.json';
import { BASE_NAVIGATION } from '../navigation';
import type { ReleaseDefinition } from '../release';

export const release: ReleaseDefinition<BaseConfig> = {
  id: 'base', version: process.env.STOREWEAVE_RELEASE_VERSION ?? packageJson.version, baseVersion: PLATFORM_VERSION,
  config: baseConfigDefinition, roles: BASE_ROLES, legacyBaselines: [],
  manifestConfig: { version: 1, store: { id: 'build-only', name: 'Build only' }, database: { url: 'postgres://manifest.invalid/unused' } },
  // 沒有商務模組的網站也是網站：site 模組帶來設定、導覽與首頁（ADR 0046）。
  createModules: () => [createSiteModule({ defaultNavigation: BASE_NAVIGATION, ownsHomePage: true })],
  availableExtensions: {}, availableThemes: { base: baseTheme },
};
