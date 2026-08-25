/** 呼叫者身分。所有 Command / Query 都必須帶。 */
export interface Actor {
  readonly id: string;
  /**
   * `user` 是後台操作者，`customer` 是前台顧客。兩者共用同一套帳號與 session，
   * 但身分型別分開，稽核紀錄與資料範圍才分得出誰是誰。
   */
  readonly type: 'user' | 'customer' | 'service' | 'extension' | 'system';
  readonly displayName?: string;
  readonly permissions: readonly string[];
  /** extension actor 才會有；用於 audit 與權限縮限 */
  readonly extensionId?: string;
  /**
   * ExtensionHost derives these from the manifest's registered providers.
   * Provider-scoped core operations use them in addition to ordinary RBAC, so
   * one carrier extension cannot read or write another carrier's shipments.
   */
  readonly providerBindings?: readonly string[];
}

export const SYSTEM_ACTOR: Actor = Object.freeze({
  id: 'system',
  type: 'system',
  displayName: 'system',
  permissions: Object.freeze(['*']) as readonly string[],
});

export function extensionActor(extensionId: string, permissions: readonly string[], providerBindings: readonly string[] = []): Actor {
  return {
    id: `extension:${extensionId}`,
    type: 'extension',
    displayName: extensionId,
    permissions: [...permissions],
    extensionId,
    providerBindings: [...providerBindings],
  };
}
