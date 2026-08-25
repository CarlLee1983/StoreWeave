/** MVP 的角色→權限映射，由設定檔的 API token 指向角色。 */
export const BUILT_IN_ROLES: Record<string, readonly string[]> = {
  admin: ['*'],
  staff: ['catalog:read', 'catalog:write', 'inventory:read', 'inventory:write', 'order:read', 'order:write', 'refund:read', 'refund:write', 'rma:read', 'rma:write', 'invoice:read', 'invoice:write', 'promotion:read', 'promotion:write', 'promotion:quote', 'customers:manage', 'shipping:read', 'shipping:shipment-read', 'shipping:label-read', 'shipping:write', 'notification:read', 'erp:read', 'erp:write'],
  readonly: ['catalog:read', 'inventory:read', 'order:read', 'invoice:read', 'promotion:read', 'shipping:read', 'shipping:shipment-read', 'notification:read', 'erp:read'],
  mcp: ['catalog:read', 'inventory:read', 'inventory:write', 'order:read', 'analytics:read'],
  // 匿名訪客。刻意沒有 order:read：無範圍的訂單讀取等於任何人猜到訂單號就能讀別人的
  // 訂單。訂單頁在工單 21 之後需要登入，訪客沒有訂單可看。
  storefront: ['catalog:read', 'inventory:read', 'order:write', 'promotion:quote', 'shipping:read', 'customer:register', 'cart:read', 'cart:write'],
  // 已登入的顧客。讀取仍需 query handler 依 actor 限縮到自己的資料。
  customer: ['catalog:read', 'inventory:read', 'order:read', 'order:write', 'refund:read', 'rma:read', 'rma:create', 'promotion:quote', 'shipping:read', 'customer:read', 'customer:write', 'cart:read', 'cart:write'],
};

export function permissionsForRole(role: string): readonly string[] {
  // 用 hasOwn 而不是索引取值：`BUILT_IN_ROLES['constructor']` 會回傳 Function 而不是 undefined。
  return Object.hasOwn(BUILT_IN_ROLES, role) ? BUILT_IN_ROLES[role]! : [];
}
