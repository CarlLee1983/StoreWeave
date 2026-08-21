/** MVP 的角色→權限映射，由設定檔的 API token 指向角色。 */
export const BUILT_IN_ROLES: Record<string, readonly string[]> = {
  admin: ['*'],
  staff: ['catalog:read', 'catalog:write', 'inventory:read', 'inventory:write', 'order:read', 'order:write', 'erp:read', 'erp:write'],
  readonly: ['catalog:read', 'inventory:read', 'order:read', 'erp:read'],
  mcp: ['catalog:read', 'inventory:read', 'inventory:write', 'order:read', 'analytics:read'],
  // 匿名訪客。它的無範圍 order:read 是一個既有的授權缺口（任何人猜到訂單號就能讀別人的
  // 訂單），連同下單後的訂單確認頁一起在工單 12 處理——在顧客登入存在之前單獨拔掉它，
  // 只會讓前台結帳完直接 403。
  storefront: ['catalog:read', 'inventory:read', 'order:write', 'order:read'],
  // 已登入的顧客。讀取仍需 query handler 依 actor 限縮到自己的資料。
  customer: ['catalog:read', 'inventory:read', 'order:read', 'order:write', 'customer:read', 'customer:write'],
};

export function permissionsForRole(role: string): readonly string[] {
  // 用 hasOwn 而不是索引取值：`BUILT_IN_ROLES['constructor']` 會回傳 Function 而不是 undefined。
  return Object.hasOwn(BUILT_IN_ROLES, role) ? BUILT_IN_ROLES[role]! : [];
}
