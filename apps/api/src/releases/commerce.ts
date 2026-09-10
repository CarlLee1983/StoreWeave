import type { Type } from '@nestjs/common';
import { collectPages } from '@storeweave/kernel';
import type { ReleaseHttpAdapter } from '../release-adapter';
import { startSession } from '../http/session-start';
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
      // 前台路由來自模組宣告的頁面；StorefrontController 只剩登入表單、
      // 外部回呼與 Theme 靜態資產（ADR 0045）。
      const deps = { runtime, theme, anonymousRole: 'storefront' };
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
