import type { Type } from '@nestjs/common';
import { collectPages } from '@storeweave/kernel';
import type { ReleaseHttpAdapter } from '../release-adapter';
import { startSession } from '../http/session-start';
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
import { NotificationsController } from '../controllers/notifications.controller';

export const httpAdapter: ReleaseHttpAdapter = {
  // 匿名訪客也讀得到導覽與網站設定；base 有前台之後就需要一個名字（ADR 0046）。
  releaseId: 'base', anonymousRole: 'visitor', startSession,
  controllers(_config, { runtime, theme }) {
    const controllers: Type[] = [
      HealthController, MetaController, AuthController, SystemController, StorageController,
      NotificationsController, ExtensionsController, UsersController, ApiTokensController,
    ];
    if (theme) {
      const deps = { runtime, theme, anonymousRole: 'visitor' };
      controllers.push(createStorefrontController(collectPages(runtime.modules), {
        theme,
        buildContext: (req, reply) => buildThemeContext(deps, req, reply),
        resolveContext: (req, reply) => buildResolveContext(deps, req, reply),
        renderError: (req, reply, error) => renderStorefrontError(deps, reply, error, req),
      }));
    }
    return controllers;
  },
};
