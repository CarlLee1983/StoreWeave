/** 呼叫者身分。所有 Command / Query 都必須帶。 */
export interface Actor {
  readonly id: string;
  readonly type: 'user' | 'service' | 'extension' | 'system';
  readonly displayName?: string;
  readonly permissions: readonly string[];
  /** extension actor 才會有；用於 audit 與權限縮限 */
  readonly extensionId?: string;
}

export const SYSTEM_ACTOR: Actor = Object.freeze({
  id: 'system',
  type: 'system',
  displayName: 'system',
  permissions: Object.freeze(['*']) as readonly string[],
});

export function extensionActor(extensionId: string, permissions: readonly string[]): Actor {
  return {
    id: `extension:${extensionId}`,
    type: 'extension',
    displayName: extensionId,
    permissions: [...permissions],
    extensionId,
  };
}
