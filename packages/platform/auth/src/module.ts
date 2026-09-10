import packageJson from '../package.json';
import { PlatformError } from '@storeweave/contracts';
import { defineModule, type AuthenticationPort } from '@storeweave/kernel';
import { createAuthPages } from './pages';

/**
 * 認證頁面。服務放在 `platform-identity`，這個模組只擁有前台的那幾條路由——
 * identity 由 kernel 無條件掛載，讓它宣告頁面等於「頁面集合由 release 決定」
 * 出現一個永久的例外（ADR 0047）。
 */
export interface AuthModuleOptions {
  /** 這個 release 的會員 actor type：購物站 `['customer']`，形象站 `['user']`。 */
  readonly signedInActorTypes: readonly string[];
}

export function createAuthModule(options: AuthModuleOptions) {
  let authentication: AuthenticationPort | undefined;

  return defineModule({
    name: 'platform-auth',
    version: packageJson.version,
    baseVersionRange: '^1.0.0',
    dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }] },
    bindPorts: (ports) => { authentication = ports.authentication; },
    pages: createAuthPages({
      signedInActorTypes: options.signedInActorTypes,
      authentication: () => {
        // 走到這裡表示模組被載入卻沒有被綁定：那是組裝錯誤。不用 validation——
        // 400 的訊息會被錯誤頁原樣印給訪客看。
        if (!authentication) throw PlatformError.internal('platform-auth 尚未綁定 authentication port');
        return authentication;
      },
    }),
  });
}
