/** MVP 的角色→權限映射，由設定檔的 API token 指向角色。 */
export const BUILT_IN_ROLES: Record<string, readonly string[]> = {
  admin: ['*'],
  staff: ['catalog:read', 'catalog:write', 'inventory:read', 'inventory:write', 'order:read', 'order:write', 'refund:read', 'refund:write', 'rma:read', 'rma:write', 'invoice:read', 'invoice:write', 'loyalty:write', 'promotion:read', 'promotion:write', 'promotion:quote', 'customers:manage', 'shipping:read', 'shipping:shipment-read', 'shipping:label-read', 'shipping:write', 'notification:read', 'erp:read', 'erp:write', 'content:read', 'content:write', 'content:public-read', 'contact:read', 'contact:write', 'storage:read', 'storage:write', 'storage:delete', 'storage:share', 'notifications:read', 'notifications:inbox'],
  readonly: ['catalog:read', 'inventory:read', 'order:read', 'invoice:read', 'promotion:read', 'shipping:read', 'shipping:shipment-read', 'notification:read', 'erp:read', 'content:read', 'contact:read', 'storage:read', 'notifications:read', 'notifications:inbox'],
  mcp: ['catalog:read', 'inventory:read', 'inventory:write', 'order:read', 'analytics:read'],
  // 匿名訪客。刻意沒有 order:read：無範圍的訂單讀取等於任何人猜到訂單號就能讀別人的
  // 訂單。訂單頁在工單 21 之後需要登入，訪客沒有訂單可看。
  storefront: ['catalog:read', 'inventory:read', 'order:write', 'promotion:quote', 'shipping:read', 'customer:register', 'cart:read', 'cart:write', 'content:public-read', 'contact:submit'],
  // 已登入的顧客。讀取仍需 query handler 依 actor 限縮到自己的資料。
  customer: ['catalog:read', 'inventory:read', 'order:read', 'order:write', 'refund:read', 'rma:read', 'rma:create', 'promotion:quote', 'shipping:read', 'customer:read', 'customer:write', 'cart:read', 'cart:write', 'content:public-read', 'contact:submit', 'notifications:inbox'],
};

export function permissionsForRole(role: string): readonly string[] {
  // 用 hasOwn 而不是索引取值：`BUILT_IN_ROLES['constructor']` 會回傳 Function 而不是 undefined。
  return Object.hasOwn(BUILT_IN_ROLES, role) ? BUILT_IN_ROLES[role]! : [];
}

/** Release-owned identity and token policy; domain permissions remain plain names. */
export interface ReleaseRole {
  readonly permissions: readonly string[];
  readonly tokenAllowed: boolean;
  readonly account: false | {
    readonly actorType: 'user' | 'customer';
    readonly sessionTtl: 'operator' | 'customer';
    readonly minPasswordLength: number;
    readonly adminCreatable: boolean;
  };
}

export type ReleaseRoleCatalog = Readonly<Record<string, ReleaseRole>>;

export function roleFor(catalog: ReleaseRoleCatalog, role: string): ReleaseRole | undefined {
  return Object.hasOwn(catalog, role) ? catalog[role] : undefined;
}

const operatorAccount = {
  actorType: 'user', sessionTtl: 'operator', minPasswordLength: 12, adminCreatable: true,
} as const;

export const BASE_ROLES: ReleaseRoleCatalog = {
  admin: { permissions: ['*'], tokenAllowed: true, account: operatorAccount },
  staff: { permissions: ['users:read', 'jobs:read', 'jobs:write', 'storage:read', 'storage:write', 'storage:delete', 'storage:share', 'notifications:read', 'notifications:inbox'], tokenAllowed: true, account: operatorAccount },
  readonly: { permissions: ['users:read', 'jobs:read', 'storage:read', 'notifications:read', 'notifications:inbox'], tokenAllowed: true, account: operatorAccount },
};

export const COMMERCE_ROLES: ReleaseRoleCatalog = Object.fromEntries(
  Object.entries(BUILT_IN_ROLES).map(([name, permissions]) => [name, {
    permissions,
    tokenAllowed: ['admin', 'staff', 'readonly', 'mcp'].includes(name),
    account: name === 'customer'
      ? { actorType: 'customer', sessionTtl: 'customer', minPasswordLength: 8, adminCreatable: false }
      : operatorAccount,
  }]),
);
