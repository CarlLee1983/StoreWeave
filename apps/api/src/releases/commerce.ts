import type { Type } from '@nestjs/common';
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
import { ShippingController } from '../controllers/shipping.controller';
import { CallbackController } from '../controllers/callback.controller';
import { RefundController } from '../controllers/refund.controller';
import { InvoiceController } from '../controllers/invoice.controller';
import { LoyaltyController } from '../controllers/loyalty.controller';
import { NotificationController } from '../controllers/notification.controller';
import { ContentArticleController, ContentContactController } from '../controllers/content.controller';
import { RmaController } from '../controllers/rma.controller';
import { McpController } from '../mcp/mcp.controller';
import { StorefrontController } from '../storefront/storefront.controller';

export const httpAdapter: ReleaseHttpAdapter = {
  releaseId: 'commerce', anonymousRole: 'storefront', startSession,
  controllers(config) {
    const controllers: Type[] = [
      HealthController, MetaController, AuthController, CatalogController, InventoryController, SystemController,
      OrderController, PromotionController, CouponController, CustomerController, CartController, ShippingController, RefundController, RmaController, InvoiceController, LoyaltyController, NotificationController, CallbackController, AnalyticsController, ContentArticleController, ContentContactController, ExtensionsController, StorefrontController,
    ];
    if (config.mcp.enabled) controllers.push(McpController);

    return controllers;
  },
};
