import type { Type } from '@nestjs/common';
import { collectPages } from '@storeweave/kernel';
import type { ReleaseHttpAdapter } from '../release-adapter';
import { startSession } from '../http/session-start';
import { clearSession } from '../http/session-clear';
import { AnalyticsController } from '../controllers/analytics.controller';
import { AuthController } from '../controllers/auth.controller';
import { CatalogController } from '../controllers/catalog.controller';
import { ExtensionsController } from '../controllers/extensions.controller';
import { HealthController } from '../controllers/health.controller';
import { InventoryController } from '../controllers/inventory.controller';
import { MetaController } from '../controllers/meta.controller';
import { CartController } from '../controllers/cart.controller';
import { CustomerController } from '../controllers/customer.controller';
import { OrderController } from '../controllers/order.controller';
import { PromotionController } from '../controllers/promotion.controller';
import { CouponController } from '../controllers/coupon.controller';
import { SystemController } from '../controllers/system.controller';
import { UsersController } from '../controllers/users.controller';
import { ApiTokensController } from '../controllers/api-tokens.controller';
import { ShippingController } from '../controllers/shipping.controller';
import { CallbackController } from '../controllers/callback.controller';
import { RefundController } from '../controllers/refund.controller';
import { InvoiceController } from '../controllers/invoice.controller';
import { LoyaltyController } from '../controllers/loyalty.controller';
import { NotificationController } from '../controllers/notification.controller';
import { NotificationsController } from '../controllers/notifications.controller';
import { ContentArticleController, ContentContactController } from '../controllers/content.controller';
import { RmaController } from '../controllers/rma.controller';
import { McpController } from '../mcp/mcp.controller';
import { StorefrontController } from '../storefront/storefront.controller';
import { createStorefrontController } from '../storefront/storefront-routes';
import { buildResolveContext, buildThemeContext, renderStorefrontError } from '../storefront/storefront-context';
import { StorageController } from '../controllers/storage.controller';

export const httpAdapter: ReleaseHttpAdapter = {
  releaseId: 'commerce', anonymousRole: 'storefront', startSession,
  controllers(config, { runtime, theme }) {
    const controllers: Type[] = [
      HealthController, MetaController, AuthController, CatalogController, InventoryController, SystemController, StorageController, UsersController, ApiTokensController,
      OrderController, PromotionController, CouponController, CustomerController, CartController, ShippingController, RefundController, RmaController, InvoiceController, LoyaltyController, NotificationController, NotificationsController, CallbackController, AnalyticsController, ContentArticleController, ContentContactController, ExtensionsController, StorefrontController,
    ];
    if (config.mcp.enabled) controllers.push(McpController);
    if (theme) {
      // 前台路由來自模組宣告的頁面；StorefrontController 只剩外部回呼與 Theme 靜態資產
      // （ADR 0045；登入、登出、註冊與密碼重設四組都已遷移，工單 94-96）。
      const deps = { runtime, theme, anonymousRole: 'storefront' };
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
