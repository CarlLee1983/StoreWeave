import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ApiTokenGuard } from './http/auth';
import { PlatformExceptionFilter } from './http/exception.filter';
import { AnalyticsController } from './controllers/analytics.controller';
import { AuthController } from './controllers/auth.controller';
import { CatalogController } from './controllers/catalog.controller';
import { ExtensionsController } from './controllers/extensions.controller';
import { HealthController } from './controllers/health.controller';
import { InventoryController } from './controllers/inventory.controller';
import { MetaController } from './controllers/meta.controller';
import { CartController } from './controllers/cart.controller';
import { CustomerController } from './controllers/customer.controller';
import { OrderController } from './controllers/order.controller';
import { PromotionController } from './controllers/promotion.controller';
import { CouponController } from './controllers/coupon.controller';
import { SystemController } from './controllers/system.controller';
import { ShippingController } from './controllers/shipping.controller';
import { CallbackController } from './controllers/callback.controller';
import { RefundController } from './controllers/refund.controller';
import { RmaController } from './controllers/rma.controller';
import { McpController } from './mcp/mcp.controller';
import { StorefrontController } from './storefront/storefront.controller';
import { RELEASE, RUNTIME, THEME, type ReleaseInfo, type Runtime, type StorefrontTheme } from './tokens';

@Module({})
export class AppModule {
  static forRuntime(runtime: Runtime, theme: StorefrontTheme, release: ReleaseInfo): DynamicModule {
    const controllers = [
      HealthController, MetaController, AuthController, CatalogController, InventoryController, SystemController,
      OrderController, PromotionController, CouponController, CustomerController, CartController, ShippingController, RefundController, RmaController, CallbackController, AnalyticsController, ExtensionsController, StorefrontController,
    ];
    if (runtime.config.mcp.enabled) controllers.push(McpController as never);

    return {
      module: AppModule,
      controllers,
      providers: [
        { provide: RUNTIME, useValue: runtime },
        { provide: THEME, useValue: theme },
        { provide: RELEASE, useValue: release },
        { provide: APP_GUARD, useClass: ApiTokenGuard },
        { provide: APP_FILTER, useClass: PlatformExceptionFilter },
      ],
    };
  }
}
