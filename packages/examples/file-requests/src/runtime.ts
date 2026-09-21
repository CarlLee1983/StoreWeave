import { BASE_ROLES, type ReleaseRole, type ReleaseRoleCatalog } from '@storeweave/authorization';
import { bindModuleCapability } from '@storeweave/kernel';
import type { BaseConfig } from '@storeweave/config';
import { createFileRequestRenderers, createFileRequestsModule, FILE_REQUEST_PERMISSIONS } from '@storeweave/example-file-requests';
import { createContentModule } from '@storeweave/content';
import { createSiteModule, navigationItem, siteSettingsService } from '@storeweave/site';
import { createAuthModule } from '@storeweave/auth';
import { defineRuntimeRelease } from '../../../platform/release/src/runtime';
import { BASE_NAVIGATION } from '../../../releases/base/src/navigation';
import { fileRequestsReleaseDefinition } from './definition';
import { fileRequestsConfigProjectionFactory } from './config';
import { fileRequestsStorefrontProjectionFactory } from './storefront';

const withPermissions = (role: ReleaseRole, permissions: readonly string[]): ReleaseRole =>
  ({ ...role, permissions: [...role.permissions, ...permissions] });

const fileRequestsRoles: ReleaseRoleCatalog = {
  ...BASE_ROLES,
  staff: withPermissions(BASE_ROLES.staff!, Object.values(FILE_REQUEST_PERMISSIONS)),
  member: withPermissions(BASE_ROLES.member!, [FILE_REQUEST_PERMISSIONS.submit]),
};

export const release = defineRuntimeRelease<BaseConfig>(fileRequestsReleaseDefinition, {
  config: fileRequestsConfigProjectionFactory,
  storefront: fileRequestsStorefrontProjectionFactory,
  roles: fileRequestsRoles,
  legacyBaselines: [],
  manifestConfig: { version: 1, store: { id: 'build-only', name: 'Build only' }, database: { url: 'postgres://manifest.invalid/unused' } },
  createModules: ({ config, providers }) => [
    createSiteModule({
      defaultNavigation: [...BASE_NAVIGATION, navigationItem({ menu: 'primary', label: '檔案處理申請', href: '/file-requests', position: 90 })],
      ownsHomePage: true,
    }),
    createContentModule({ contactNotificationRecipient: bindModuleCapability('platform-site', 'platform.site.contact-notification-recipient', siteSettingsService.contactNotificationEmail) }),
    createAuthModule({ signedInActorTypes: ['user'] }),
    createFileRequestsModule({
      reviewUrl: new URL('/file-requests/review', config.http.publicUrl).toString(),
      reviewerEmail: config.store.supportEmail,
    }),
  ],
  availableExtensions: {},
});
