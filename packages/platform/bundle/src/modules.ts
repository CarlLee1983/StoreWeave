import { bindModuleCapability, type PlatformModule } from '@storeweave/kernel';
import type { ExtensionDefinition, ProviderRegistry } from '@storeweave/extension-sdk';
import { catalogModule } from '@storeweave/catalog';
import { inventoryModule } from '@storeweave/inventory';
import { createOrderModule, orderFulfillmentService, orderInvoiceService, orderNotificationService, orderRefundService, orderReturnService } from '@storeweave/order';
import { createInvoiceModule } from '@storeweave/invoice';
import { createRefundModule, refundShipmentGuard } from '@storeweave/refund';
import { createContentModule } from '@storeweave/content';
import { createRmaModule } from '@storeweave/rma';
import { customerModule } from '@storeweave/customer';
import { createCart } from '@storeweave/cart';
import { createShippingModule, shippingService } from '@storeweave/shipping';
import { createCouponModule } from '@storeweave/coupon';
import { createLoyaltyModule } from '@storeweave/loyalty';
import { createPromotionModule } from '@storeweave/promotion';
import { createNotificationModule } from '@storeweave/notification';
import { createAuthModule } from '@storeweave/auth';
import { createSiteModule } from '@storeweave/site';
import { COMMERCE_NAVIGATION } from './navigation';
import { mockPaymentExtension } from '@storeweave/ext-mock-payment';
import { mockInvoiceExtension } from '@storeweave/ext-mock-invoice';
import { ecpayPaymentExtension } from '@storeweave/ext-ecpay';
import { ecpayInvoiceExtension } from '@storeweave/ext-ecpay-invoice';
import { ecpayLogisticsExtension } from '@storeweave/ext-ecpay-logistics';
import { demoErpExtension } from '@storeweave/ext-demo-erp';
import { mcpExtension } from '@storeweave/ext-mcp';

/**
 * Commerce Release Bundle：這個版本編成哪些產品模組與可用 Extension。
 * Kernel 不綁這份清單；換成別的產品 = 換成別的模組集合。
 * Extension 是建置時組裝的 —— 正式主機不會、也不能在執行期上傳新的 Extension。
 */
export function coreModules(options: {
  providers: ProviderRegistry;
  defaultCurrency: string;
  orderNumberPrefix: string;
  /** 店鋪時區。生日這類「當天」的判斷需要它——切片邊界對齊的是 UTC。 */
  timezone: string;
  locale: string;
}): PlatformModule[] {
  return [
    catalogModule,
    inventoryModule,
    customerModule,
    createCart({ defaultCurrency: options.defaultCurrency }),
    createShippingModule(
      bindModuleCapability('order', 'commerce.order.shipment-lookup', orderFulfillmentService), options.providers,
      bindModuleCapability('refund', 'commerce.refund.shipment-guard', refundShipmentGuard),
    ),
    createPromotionModule({ defaultCurrency: options.defaultCurrency }),
    createCouponModule({
      timezone: options.timezone,
      currency: options.defaultCurrency,
      locale: options.locale,
    }),
    createLoyaltyModule({ currency: options.defaultCurrency, locale: options.locale }),
    createOrderModule({
      providers: options.providers,
      defaultCurrency: options.defaultCurrency,
      orderNumberPrefix: options.orderNumberPrefix,
    }),
    createInvoiceModule(bindModuleCapability('order', 'commerce.order.invoice-lookup', orderInvoiceService), options.providers),
    createNotificationModule(bindModuleCapability('order', 'commerce.order.notification-lookup', orderNotificationService), { locale: options.locale }),
    createRefundModule(
      bindModuleCapability('order', 'commerce.order.refund-operations', orderRefundService),
      bindModuleCapability('shipping', 'commerce.shipping.shipment-lookup', { hasShipmentForOrder: shippingService.hasShipmentForOrder }),
      options.providers,
    ),
    createRmaModule(
      bindModuleCapability('order', 'commerce.order.return-operations', orderReturnService),
      bindModuleCapability('shipping', 'commerce.shipping.return-lookup', { hasReturnableShipment: shippingService.hasReturnableShipment }),
    ),
    createContentModule(),
    // `/` 由 catalog 宣告，所以 site 模組在這裡不提供首頁；它帶來的是網站設定與導覽（ADR 0046）。
    createSiteModule({ defaultNavigation: COMMERCE_NAVIGATION }),
    createAuthModule({ signedInActorTypes: ['customer'] }),
  ];
}

export const AVAILABLE_EXTENSIONS: Record<string, ExtensionDefinition<any>> = {
  'mock-payment': mockPaymentExtension,
  'mock-invoice': mockInvoiceExtension,
  ecpay: ecpayPaymentExtension,
  'ecpay-invoice': ecpayInvoiceExtension,
  'ecpay-logistics': ecpayLogisticsExtension,
  'demo-erp': demoErpExtension,
  mcp: mcpExtension,
};

/** 這個 Release 已知的所有事件名稱與權限鍵，供 contract test 與 doctor 使用。 */
export function knownEventNames(): string[] {
  const providers = { list: () => [] } as unknown as ProviderRegistry;
  return coreModules({ providers, defaultCurrency: 'TWD', orderNumberPrefix: 'SW', timezone: 'Asia/Taipei', locale: 'zh-TW' })
    .flatMap((m) => (m.events ?? []).map((e) => e.name))
    .sort();
}

export function knownPermissionKeys(): string[] {
  const providers = { list: () => [] } as unknown as ProviderRegistry;
  return coreModules({ providers, defaultCurrency: 'TWD', orderNumberPrefix: 'SW', timezone: 'Asia/Taipei', locale: 'zh-TW' })
    .flatMap((m) => (m.permissions ?? []).map((p) => p.key))
    .sort();
}
