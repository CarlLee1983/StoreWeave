import packageJson from '../package.json';
import { defineModule } from '@storeweave/kernel';
import {
  createGetSiteChromeHandler, getSiteChromeQuery, replaceNavigationCommand, replaceNavigationHandler,
  updateSiteSettingsCommand, updateSiteSettingsHandler,
} from './descriptors';
import { siteMigrations } from './migrations';
import { sitePages } from './pages';
import type { SiteNavigationItem } from './types';

export interface SiteModuleOptions {
  /**
   * 這個 release 的預設導覽。資料庫空著的時候用它渲染，店家改過某一組之後
   * 那一組換成資料庫的內容（ADR 0046）。
   */
  readonly defaultNavigation?: readonly SiteNavigationItem[];
  /**
   * 由這個模組提供 `/`。有 catalog 的 release 要設 false——兩個模組宣告同一條路由
   * 是組裝錯誤，而首頁該長什麼樣是 release 的決定，不是平台的。
   */
  readonly ownsHomePage?: boolean;
}

export function createSiteModule(options: SiteModuleOptions = {}) {
  return defineModule({
    name: 'platform-site',
    version: packageJson.version,
    baseVersionRange: '^1.0.0',
  dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }] },
    capabilities: { provides: ['platform.site.contact-notification-recipient'] },
    data: { owns: ['platform_site_settings', 'platform_site_navigation_items'] },
    migrations: siteMigrations,
    permissions: [
      { key: 'site:public-read', description: '讀取公開的網站設定與導覽', owner: 'platform-site' },
      { key: 'site:manage', description: '修改網站設定與導覽', owner: 'platform-site' },
    ],
    queries: [
      { descriptor: getSiteChromeQuery, handler: createGetSiteChromeHandler(options.defaultNavigation ?? []) },
    ],
    commands: [
      { descriptor: updateSiteSettingsCommand, handler: updateSiteSettingsHandler },
      { descriptor: replaceNavigationCommand, handler: replaceNavigationHandler },
    ],
    ...(options.ownsHomePage ? { pages: sitePages } : {}),
  });
}
