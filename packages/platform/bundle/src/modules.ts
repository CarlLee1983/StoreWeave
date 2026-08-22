import type { PlatformModule } from '@storeweave/kernel';
import type { ExtensionDefinition, ProviderRegistry } from '@storeweave/extension-sdk';
import { catalogModule } from '@storeweave/catalog';
import { inventoryModule } from '@storeweave/inventory';
import { createOrderModule } from '@storeweave/order';
import { customerModule } from '@storeweave/customer';
import { createCart } from '@storeweave/cart';
import { createCouponModule } from '@storeweave/coupon';
import { createPromotionModule } from '@storeweave/promotion';
import { mockPaymentExtension } from '@storeweave/ext-mock-payment';
import { mockNotificationExtension } from '@storeweave/ext-mock-notification';
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
    createPromotionModule({ defaultCurrency: options.defaultCurrency }),
    createCouponModule({
      providers: options.providers,
      timezone: options.timezone,
      currency: options.defaultCurrency,
      locale: options.locale,
    }),
    createOrderModule({
      providers: options.providers,
      defaultCurrency: options.defaultCurrency,
      orderNumberPrefix: options.orderNumberPrefix,
    }),
  ];
}

export const AVAILABLE_EXTENSIONS: Record<string, ExtensionDefinition<any>> = {
  'mock-payment': mockPaymentExtension,
  'mock-notification': mockNotificationExtension,
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