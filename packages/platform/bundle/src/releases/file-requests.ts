import { BASE_ROLES, type ReleaseRole, type ReleaseRoleCatalog } from '@storeweave/authorization';
import { bindModuleCapability, type StorefrontTheme } from '@storeweave/kernel';
import { baseConfigDefinition, type BaseConfig } from '@storeweave/config';
import { PLATFORM_VERSION } from '@storeweave/contracts';
import { createAuthModule } from '@storeweave/auth';
import { baseTheme, renderBaseLayout } from '@storeweave/theme-base';
import { createSiteModule, navigationItem, siteSettingsService } from '@storeweave/site';
import { createContentModule } from '@storeweave/content';
import { createFileRequestRenderers, createFileRequestsModule, FILE_REQUEST_PERMISSIONS } from '@storeweave/example-file-requests';
import packageJson from '../../package.json';
import { BASE_NAVIGATION } from '../navigation';
import type { ReleaseDefinition } from '../release';

/**
 * B16 的站點組裝範例：base release 加上一個非商務模組。接一個新模組要動的只有模組套件
 * 與這類 release 檔——角色授權、導覽、Theme renderer 與模組選項都在這裡決定（ADR 0050）。
 */
const withPermissions = (role: ReleaseRole, permissions: readonly string[]): ReleaseRole =>
  ({ ...role, permissions: [...role.permissions, ...permissions] });

export const FILE_REQUESTS_ROLES: ReleaseRoleCatalog = {
  ...BASE_ROLES,
  staff: withPermissions(BASE_ROLES.staff!, Object.values(FILE_REQUEST_PERMISSIONS)),
  member: withPermissions(BASE_ROLES.member!, [FILE_REQUEST_PERMISSIONS.submit]),
};

/** Base Theme 加上模組頁面的 renderer；外框沿用 base Theme，所以頁面長得一致。 */
const fileRequestsTheme: StorefrontTheme = {
  ...baseTheme,
  renderers: { ...baseTheme.renderers, ...createFileRequestRenderers(renderBaseLayout) },
};

export const release: ReleaseDefinition<BaseConfig> = {
  id: 'file-requests', version: process.env.STOREWEAVE_RELEASE_VERSION ?? packageJson.version, baseVersion: PLATFORM_VERSION,
  config: baseConfigDefinition, roles: FILE_REQUESTS_ROLES, legacyBaselines: [],
  manifestConfig: { version: 1, store: { id: 'build-only', name: 'Build only' }, database: { url: 'postgres://manifest.invalid/unused' } },
  createModules: ({ config }) => [
    createSiteModule({
      defaultNavigation: [...BASE_NAVIGATION, navigationItem({ menu: 'primary', label: '檔案處理申請', href: '/file-requests', position: 90 })],
      ownsHomePage: true,
    }),
    createContentModule({ contactNotificationRecipient: bindModuleCapability('platform-site', 'platform.site.contact-notification-recipient', siteSettingsService.contactNotificationEmail) }),
    createAuthModule({ signedInActorTypes: ['user'] }),
    // 選項只被 handler 捕捉，模組圖不隨設定改變（ReleaseDefinition.createModules 的約定）。
    createFileRequestsModule({
      reviewUrl: new URL('/file-requests/review', config.http.publicUrl).toString(),
      reviewerEmail: config.store.supportEmail,
    }),
  ],
  availableExtensions: {}, availableThemes: { base: fileRequestsTheme },
};
