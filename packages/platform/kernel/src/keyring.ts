import type { BaseConfig, SecretProvider } from '@storeweave/config';
import { PlatformError } from '@storeweave/contracts';
import { createKeyring, type Keyring } from '@storeweave/crypto';

/**
 * 從設定與 Secret Provider 組出簽章金鑰環。
 *
 * 宣告了金鑰卻讀不到秘密就在啟動時失敗——這種缺漏若拖到第一個簽章請求才炸，
 * 會變成一個已經上線、卻無法發出下載連結的部署。沒宣告任何金鑰則回傳
 * undefined：乾淨的 base release 不需要簽章能力，不該被迫產生一把金鑰。
 */
export function resolveKeyring(config: BaseConfig, secrets: SecretProvider): Keyring | undefined {
  const { signingKeys, activeSigningKeyId } = config.security;
  if (signingKeys.length === 0) return undefined;

  const keys = signingKeys.map((key) => {
    const secret = secrets.get(key.secretRef);
    if (!secret) {
      throw new Error(`Signing key ${key.id} requires the secret ${key.secretRef}, which is not available`);
    }
    return { id: key.id, secret };
  });

  // activeSigningKeyId 在 schema 已保證存在且屬於 signingKeys。
  try {
    return createKeyring({ activeKeyId: activeSigningKeyId!, keys });
  } catch (error) {
    // createKeyring 的訊息只提到 key id 與長度需求，不含秘密本身。
    throw new Error(`Invalid signing key configuration: ${(error as Error).message}`, { cause: error });
  }
}

/**
 * 取用簽章能力。缺設定時給出可據以修正的訊息，而不是讓呼叫端各自處理
 * undefined——短效連結與重設信在沒有金鑰時只能是設定錯誤，不是執行期分支。
 */
export function requireKeyring(source: { readonly keyring?: Keyring }, purpose: string): Keyring {
  if (!source.keyring) {
    throw PlatformError.internal(
      `The ${purpose} capability requires a signing key; configure security.signingKeys and its secret`,
    );
  }
  return source.keyring;
}
