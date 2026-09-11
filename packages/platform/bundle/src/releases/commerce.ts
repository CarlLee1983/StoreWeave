import legacyBaseline from '../legacy/commerce-pre-b02.json';
import { COMMERCE_ROLES } from '@storeweave/authorization';
import { commerceConfigDefinition, type CommerceConfig } from '@storeweave/config';
import { PLATFORM_VERSION } from '@storeweave/contracts';
import { defaultTheme, WOVEN_DAY_LEGACY_MEDIA_MANIFEST } from '@storeweave/theme-default';
import packageJson from '../../package.json';
import { AVAILABLE_EXTENSIONS, coreModules } from '../modules';
import type { ReleaseDefinition } from '../release';

export const release: ReleaseDefinition<CommerceConfig> = {
  id: 'commerce', version: process.env.STOREWEAVE_RELEASE_VERSION ?? packageJson.version, baseVersion: PLATFORM_VERSION,
  config: commerceConfigDefinition, roles: COMMERCE_ROLES, legacyBaselines: [legacyBaseline],
  manifestConfig: { version: 1, store: { id: 'build-only', name: 'Build only' }, database: { url: 'postgres://manifest.invalid/unused' } },
  createModules: ({ config, providers }) => coreModules({
    providers, defaultCurrency: config.store.currency,
    orderNumberPrefix: config.store.id.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'SW',
    timezone: config.store.timezone, locale: config.store.locale,
  }),
  availableExtensions: AVAILABLE_EXTENSIONS,
  availableThemes: { default: defaultTheme },
  legacyContentMediaManifest: WOVEN_DAY_LEGACY_MEDIA_MANIFEST,
};
