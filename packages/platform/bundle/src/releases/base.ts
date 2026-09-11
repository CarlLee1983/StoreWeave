import { BASE_ROLES } from '@storeweave/authorization';
import { bindModuleCapability } from '@storeweave/kernel';
import { baseConfigDefinition, type BaseConfig } from '@storeweave/config';
import { PLATFORM_VERSION } from '@storeweave/contracts';
import { createAuthModule } from '@storeweave/auth';
import { baseTheme } from '@storeweave/theme-base';
import { createSiteModule, siteSettingsService } from '@storeweave/site';
import { createContentModule } from '@storeweave/content';
import packageJson from '../../package.json';
import { BASE_NAVIGATION } from '../navigation';
import type { ReleaseDefinition } from '../release';

export const release: ReleaseDefinition<BaseConfig> = {
  id: 'base', version: process.env.STOREWEAVE_RELEASE_VERSION ?? packageJson.version, baseVersion: PLATFORM_VERSION,
  config: baseConfigDefinition, roles: BASE_ROLES, legacyBaselines: [],
  manifestConfig: { version: 1, store: { id: 'build-only', name: 'Build only' }, database: { url: 'postgres://manifest.invalid/unused' } },
  // 沒有商務模組的網站也是網站：site 模組帶來設定、導覽與首頁（ADR 0046）。
  createModules: () => [
    createSiteModule({ defaultNavigation: BASE_NAVIGATION, ownsHomePage: true }),
    createContentModule({ contactNotificationRecipient: bindModuleCapability('platform-site', 'platform.site.contact-notification-recipient', siteSettingsService.contactNotificationEmail) }),
    // Base 的 Member 沒有 Customer 資料；未傳 registerCommand 便由 identity 自助建立 Account。
    createAuthModule({ signedInActorTypes: ['user'] }),
  ],
  availableExtensions: {}, availableThemes: { base: baseTheme },
};
