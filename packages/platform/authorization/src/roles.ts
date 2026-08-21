/** MVP 的角色→權限映射，由設定檔的 API token 指向角色。 */
export const BUILT_IN_ROLES: Record<string, readonly string[]> = {
  admin: ['*'],
  staff: ['catalog:read', 'catalog:write', 'inventory:read', 'inventory:write', 'order:read', 'order:write', 'erp:read', 'erp:write'],
  readonly: ['catalog:read', 'inventory:read', 'order:read', 'erp:read'],
  mcp: ['catalog:read', 'inventory:read', 'inventory:write', 'order:read', 'analytics:read'],
  storefront: ['catalog:read', 'inventory:read', 'order:write', 'order:read'],
};

export function permissionsForRole(role: string): readonly string[] {
  // 用 hasOwn 而不是索引取值：`BUILT_IN_ROLES['constructor']` 會回傳 Function 而不是 undefined。
  return Object.hasOwn(BUILT_IN_ROLES, role) ? BUILT_IN_ROLES[role]! : [];
}
