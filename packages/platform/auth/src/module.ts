import packageJson from '../package.json';
import { PlatformError, type Logger } from '@storeweave/contracts';
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
  /**
   * 註冊要跑哪一個命令。購物站傳建立 Customer 的那一個；未指定時由 identity 自助建立
   * Account。模組不自己決定註冊要做什麼，那是 release 的事（ADR 0041、0047）。
   */
  readonly registerCommand?: string;
}

export function createAuthModule(options: AuthModuleOptions) {
  if (options.registerCommand !== undefined && options.registerCommand.trim() === '') {
    throw new Error('platform-auth registerCommand must be non-empty when provided');
  }
  let authentication: AuthenticationPort | undefined;
  let logger: Logger | undefined;

  return defineModule({
    name: 'platform-auth',
    version: packageJson.version,
    baseVersionRange: '^1.0.0',
    dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }] },
    bindPorts: (ports) => {
      authentication = ports.authentication;
      logger = ports.logger;
    },
    pages: createAuthPages({
      signedInActorTypes: options.signedInActorTypes,
      registerCommand: options.registerCommand,
      authentication: () => {
        // 走到這裡表示模組被載入卻沒有被綁定：那是組裝錯誤。不用 validation——
        // 400 的訊息會被錯誤頁原樣印給訪客看。
        if (!authentication) throw PlatformError.internal('platform-auth 尚未綁定 authentication port');
        return authentication;
      },
      logPasswordResetFailure: (error) => {
        if (!logger) throw PlatformError.internal('platform-auth 尚未綁定 logger port');
        logger.error({ error: (error as Error).message }, 'password reset delivery failed');
      },
    }),
  });
}
