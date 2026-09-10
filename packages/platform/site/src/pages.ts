import { z } from 'zod';
import { definePage, type StorefrontHttpContract } from '@storeweave/kernel';

const htmlOnly: StorefrontHttpContract['responses'] = [
  { kind: 'html', status: 200, contentType: 'text/html; charset=utf-8', body: 'theme' },
  { kind: 'html', status: 'platform-error', contentType: 'text/html; charset=utf-8', body: 'theme' },
];

/**
 * 沒有商務模組的網站的首頁。它沒有自己的資料——標語與導覽都是網站外框，
 * 由 ThemeContext 帶進來——所以 view 是空的。有 catalog 的 release 不會載入這一頁，
 * `/` 由 `commerce.catalog.home` 宣告（見 createSiteModule 的 ownsHomePage）。
 */
export const sitePages = {
  home: definePage({
    id: 'platform.site.home',
    path: '/',
    method: 'get',
    audience: 'public',
    input: z.object({}),
    contract: {
      kind: 'storefront', request: 'none', input: { type: 'object', properties: {}, additionalProperties: false },
      responses: htmlOnly,
    },
    resolve: async () => ({ kind: 'view' as const, view: {} }),
  }),
} as const;

export type SitePages = typeof sitePages;
