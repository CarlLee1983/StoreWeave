import type { Type } from '@nestjs/common';
import { collectPages } from '@storeweave/kernel';
import type { ReleaseHttpAdapter } from '../release-adapter';
import { startSession } from '../http/session-start';
import { clearSession } from '../http/session-clear';
import { createStorefrontController } from '../storefront/storefront-routes';
import { buildResolveContext, buildThemeContext, renderStorefrontError } from '../storefront/storefront-context';
import { AuthController } from '../controllers/auth.controller';
import { ExtensionsController } from '../controllers/extensions.controller';
import { HealthController } from '../controllers/health.controller';
import { MetaController } from '../controllers/meta.controller';
import { SystemController } from '../controllers/system.controller';
import { UsersController } from '../controllers/users.controller';
import { ApiTokensController } from '../controllers/api-tokens.controller';
import { StorageController } from '../controllers/storage.controller';
import { MediaController } from '../controllers/media.controller';
import { ModuleUploadsController } from '../controllers/module-uploads.controller';
import { NotificationsController } from '../controllers/notifications.controller';
import { ContentArticleController, ContentContactController, ContentDiscoveryController, ContentPublicMediaController } from '../controllers/content.controller';
import { SiteController } from '../controllers/site.controller';

export const httpAdapter: ReleaseHttpAdapter = {
  // 匿名訪客也讀得到導覽與網站設定；base 有前台之後就需要一個名字（ADR 0046）。
  releaseId: 'base', anonymousRole: 'visitor', startSession,
  controllers(_config, { runtime, theme }) {
    const controllers: Type[] = [
      HealthController, MetaController, AuthController, SystemController, StorageController, MediaController, ModuleUploadsController,
      NotificationsController, ContentArticleController, ContentContactController, ContentPublicMediaController, ContentDiscoveryController, SiteController, ExtensionsController, UsersController, ApiTokensController,
    ];
    if (theme) {
      const deps = { runtime, theme, anonymousRole: 'visitor' };
      controllers.push(createStorefrontController(collectPages(runtime.modules), {
        theme,
        buildContext: (req, reply) => buildThemeContext(deps, req, reply),
        resolveContext: (req, reply) => buildResolveContext(deps, req, reply),
        renderError: (req, reply, error) => renderStorefrontError(deps, reply, error, req),
        sessionEffects: {
          // 走 this.startSession 而不是自由變數：頁面用的簽發實作與 adapter 對外那份
          // 因此不可能分岔（工單 92 消滅的正是這種第二份實作）。
          start: (req, reply, session) => this.startSession(runtime, req, reply, session),
          clear: (req, reply) => clearSession(runtime, req, reply),
        },
      }));
    }
    return controllers;
  },
};
