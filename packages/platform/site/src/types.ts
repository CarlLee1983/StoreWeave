import { z } from 'zod';

/**
 * menu 是 slug 而不是列舉：平台不知道一個網站有幾組導覽（ADR 0046）。
 * `primary` 與 `footer` 是預設 Theme 的用法，不是平台認得的分類。
 */
const menuSlug = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'Menu must be a lowercase slug');

/**
 * 只接受站內路徑。導覽是後台可編輯的資料，允許 `javascript:` 或外站網址等於
 * 把一個設定欄位變成注入點——真的要外連時再開，並且是另一個明確的決定。
 */
const siteHref = z.string().min(1).max(512).regex(/^\/(?![/\\])[^\s]*$/, 'Navigation href must be a site-relative path');

export const navigationItemDto = z.object({
  menu: menuSlug,
  /** 頁尾的「商品」「帳戶」這種小標。沒有分組時是 null。 */
  groupLabel: z.string().min(1).max(60).nullable(),
  label: z.string().min(1).max(60),
  href: siteHref,
  position: z.number().int().min(0).max(10_000),
  /**
   * 這一項要等某種內容有已發布的文章才出現。平台不解讀這個字串的意思，
   * 就跟它不解讀 `publishedContentKinds` 的成員一樣（ADR 0045、0046）。
   */
  requiresContentKind: z.string().min(1).max(60).nullable(),
}).strict();

export const siteSettingsDto = z.object({
  tagline: z.string().max(120),
  footerNote: z.string().max(200),
}).strict();

/** Private operator configuration; never return it from the public chrome query. */
export const siteSettingsRecordDto = siteSettingsDto.extend({
  /** Optional recipient for a B07 email when a public contact message arrives. */
  contactNotificationEmail: z.string().email().nullable(),
}).strict();

export const siteChromeDto = z.object({
  settings: siteSettingsDto,
  navigation: z.array(navigationItemDto),
}).strict();

export const updateSiteSettingsInput = siteSettingsRecordDto.partial();

export const replaceNavigationInput = z.object({
  menu: menuSlug,
  items: z.array(navigationItemDto.omit({ menu: true })).max(50),
}).strict();

export const replaceNavigationOutput = z.object({ menu: menuSlug, items: z.number().int().min(0) }).strict();

export type SiteNavigationItem = z.infer<typeof navigationItemDto>;
export type SiteSettings = z.infer<typeof siteSettingsRecordDto>;
export type SiteChrome = z.infer<typeof siteChromeDto>;
