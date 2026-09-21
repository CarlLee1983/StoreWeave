import { BASE_ROLES } from '@storeweave/authorization';
import { bindModuleCapability } from '@storeweave/kernel';
import type { BaseConfig } from '@storeweave/config';
import { createAuthModule } from '@storeweave/auth';
import { createSiteModule, siteSettingsService } from '@storeweave/site';
import { createContentModule } from '@storeweave/content';
import { PLATFORM_VERSION } from '@storeweave/contracts';
import { baseReleaseDefinition } from './definition';
import { BASE_NAVIGATION } from './navigation';
import { defineRuntimeRelease } from '../../../platform/release/src/runtime';
import { baseConfigProjectionFactory } from './config';
import { baseStorefrontProjectionFactory } from './storefront';

/** Executable Base contributions are owned by this release package. */
export const release = defineRuntimeRelease<BaseConfig>(baseReleaseDefinition, {
  config: baseConfigProjectionFactory,
  storefront: baseStorefrontProjectionFactory,
  roles: BASE_ROLES,
  legacyBaselines: [],
  manifestConfig: { version: 1, store: { id: 'build-only', name: 'Build only' }, database: { url: 'postgres://manifest.invalid/unused' } },
  createModules: () => [
    createSiteModule({ defaultNavigation: BASE_NAVIGATION, ownsHomePage: true }),
    createContentModule({ contactNotificationRecipient: bindModuleCapability('platform-site', 'platform.site.contact-notification-recipient', siteSettingsService.contactNotificationEmail) }),
    createAuthModule({ signedInActorTypes: ['user'] }),
  ],
  availableExtensions: {},
});

if (release.baseVersion !== PLATFORM_VERSION) throw new Error('Base runtime platform version does not match its ReleaseDefinition');
