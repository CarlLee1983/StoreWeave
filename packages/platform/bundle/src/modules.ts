import type { PlatformModule } from '@storeweave/kernel';
import type { ExtensionDefinition, ProviderRegistry } from '@storeweave/extension-sdk';
import { catalogModule } from '@storeweave/catalog';
import { inventoryModule } from '@storeweave/inventory';
import { createOrderModule } from '@storeweave/order';
import { mockPaymentExtension } from '@storeweave/ext-mock-payment';
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
}): PlatformModule[] {
  return [
    catalogModule,
    inventoryModule,
    createOrderModule({
      providers: options.providers,
      defaultCurrency: options.defaultCurrency,
      orderNumberPrefix: options.orderNumberPrefix,
    }),
  ];
}

export const AVAILABLE_EXTENSIONS: Record<string, ExtensionDefinition<any>> = {
  'mock-payment': mockPaymentExtension,
  'demo-erp': demoErpExtension,
  mcp: mcpExtension,
};

/** 這個 Release 已知的所有事件名稱與權限鍵，供 contract test 與 doctor 使用。 */
export function knownEventNames(): string[] {
  const providers = { list: () => [] } as unknown as ProviderRegistry;
  return coreModules({ providers, defaultCurrency: 'TWD', orderNumberPrefix: 'SW' })
    .flatMap((m) => (m.events ?? []).map((e) => e.name))
    .sort();
}

export function knownPermissionKeys(): string[] {
  const providers = { list: () => [] } as unknown as ProviderRegistry;
  return coreModules({ providers, defaultCurrency: 'TWD', orderNumberPrefix: 'SW' })
    .flatMap((m) => (m.permissions ?? []).map((p) => p.key))
    .sort();
}