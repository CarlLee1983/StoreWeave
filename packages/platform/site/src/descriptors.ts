import { z } from 'zod';
import { defineCommand, defineQuery, type CommandContext, type QueryContext } from '@storeweave/contracts';
import { resolveNavigation } from './navigation';
import { SiteRepository } from './repository';
import {
  replaceNavigationInput, replaceNavigationOutput, siteChromeDto, siteSettingsDto, updateSiteSettingsInput,
  type SiteNavigationItem,
} from './types';

const repository = new SiteRepository();

/**
 * 網站外框：標語、頁尾附註與導覽。前台每個請求組 ThemeContext 時讀它，
 * 因此權限是公開讀取——導覽本來就印在每一頁上。
 */
export const getSiteChromeQuery = defineQuery({
  name: 'platform.site.getChrome',
  summary: '讀取網站設定與導覽',
  input: z.object({}).strict(),
  output: siteChromeDto,
  permission: 'site:public-read',
});

export function createGetSiteChromeHandler(defaultNavigation: readonly SiteNavigationItem[]) {
  return async (_input: unknown, ctx: QueryContext) => {
    const [settings, stored] = await Promise.all([repository.settings(ctx.db), repository.navigation(ctx.db)]);
    return { settings, navigation: [...resolveNavigation(stored, defaultNavigation)] };
  };
}

export const updateSiteSettingsCommand = defineCommand({
  name: 'platform.site.updateSettings',
  summary: '修改網站設定',
  input: updateSiteSettingsInput,
  output: siteSettingsDto,
  permission: 'site:manage',
  idempotency: 'optional',
  audit: { action: 'site.settings.updated', resourceType: 'site', resourceId: () => 'site', redact: input => ({ ...input }) },
});

export const updateSiteSettingsHandler = async (
  input: z.infer<typeof updateSiteSettingsInput>, ctx: CommandContext,
) => repository.saveSettings(ctx.tx, input, ctx.now);

export const replaceNavigationCommand = defineCommand({
  name: 'platform.site.replaceNavigation',
  summary: '整組換掉一份導覽選單',
  input: replaceNavigationInput,
  output: replaceNavigationOutput,
  permission: 'site:manage',
  idempotency: 'optional',
  audit: { action: 'site.navigation.replaced', resourceType: 'site-navigation', resourceId: input => input.menu },
});

export const replaceNavigationHandler = async (
  input: z.infer<typeof replaceNavigationInput>, ctx: CommandContext,
) => ({ menu: input.menu, items: await repository.replaceMenu(ctx.tx, input.menu, input.items) });
