import legacyBaseline from './legacy-commerce-pre-b02.json';
import { COMMERCE_ROLES } from '@storeweave/authorization';
import type { CommerceConfig } from '@storeweave/config';
import { PLATFORM_VERSION } from '@storeweave/contracts';
import { defineRuntimeRelease } from '../../../platform/release/src/runtime';
import { commerceReleaseDefinition } from './definition';
import { AVAILABLE_EXTENSIONS, coreModules } from './modules';
import { commerceConfigProjectionFactory } from './config';
import { commerceStorefrontProjectionFactory } from './storefront';

/** Executable Commerce contributions are owned by this release package. */
export const release = defineRuntimeRelease<CommerceConfig>(commerceReleaseDefinition, {
  config: commerceConfigProjectionFactory,
  storefront: commerceStorefrontProjectionFactory,
  roles: COMMERCE_ROLES,
  legacyBaselines: [legacyBaseline],
  manifestConfig: { version: 1, store: { id: 'build-only', name: 'Build only' }, database: { url: 'postgres://manifest.invalid/unused' } },
  createModules: ({ config, providers }) => coreModules({
    providers,
    defaultCurrency: config.store.currency,
    orderNumberPrefix: config.store.id.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'SW',
    timezone: config.store.timezone,
    locale: config.store.locale,
  }),
  availableExtensions: AVAILABLE_EXTENSIONS,
});

if (release.baseVersion !== PLATFORM_VERSION) throw new Error('Commerce runtime platform version does not match its ReleaseDefinition');
