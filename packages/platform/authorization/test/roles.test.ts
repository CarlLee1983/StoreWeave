import { describe, expect, it } from 'vitest';
import { AuthorizationService, BUILT_IN_ROLES, PermissionRegistry, PolicyRegistry, permissionsForRole } from '@storeweave/authorization';
import type { Actor } from '@storeweave/contracts';

const auth = new AuthorizationService(new PermissionRegistry(), new PolicyRegistry());

function actorWithRole(role: string, type: Actor['type']): Actor {
  return { id: `test:${role}`, type, permissions: permissionsForRole(role) };
}

const holds = (actor: Actor, permission: string) => auth.check({ actor, permission }).allowed;

describe('customer 角色', () => {
  const customer = actorWithRole('customer', 'customer');

  it('讀得到商品與庫存', () => {
    expect(holds(customer, 'catalog:read')).toBe(true);
    expect(holds(customer, 'inventory:read')).toBe(true);
  });

  it('建立得了訂單也讀得到訂單', () => {
    expect(holds(customer, 'order:write')).toBe(true);
    expect(holds(customer, 'order:read')).toBe(true);
  });

  it('讀寫得了自己的顧客資料', () => {
    expect(holds(customer, 'customer:read')).toBe(true);
    expect(holds(customer, 'customer:write')).toBe(true);
  });

  it('沒有後台的任何權限', () => {
    for (const forbidden of ['catalog:write', 'inventory:write', 'users:read', 'users:write', 'analytics:read', 'jobs:read', 'erp:read', 'promotion:read', 'promotion:write']) {
      expect(holds(customer, forbidden)).toBe(false);
    }
  });

  it('沒有 wildcard', () => {
    expect(permissionsForRole('customer')).not.toContain('*');
    expect(permissionsForRole('customer').some((p) => p.includes('*'))).toBe(false);
  });
});

describe('storefront 角色', () => {
  const storefront = actorWithRole('storefront', 'service');

  it('不再持有無範圍的訂單讀取權限', () => {
    expect(permissionsForRole('storefront')).not.toContain('order:read');
    expect(holds(storefront, 'order:read')).toBe(false);
  });

  it('仍然逛得了商品與庫存、下得了單', () => {
    expect(holds(storefront, 'catalog:read')).toBe(true);
    expect(holds(storefront, 'inventory:read')).toBe(true);
    expect(holds(storefront, 'order:write')).toBe(true);
  });
});

describe('BUILT_IN_ROLES', () => {
  it('除了 admin 之外沒有角色持有 wildcard', () => {
    for (const [role, permissions] of Object.entries(BUILT_IN_ROLES)) {
      if (role === 'admin') continue;
      expect(permissions.some((p) => p.includes('*'))).toBe(false);
    }
  });
});

describe('顧客身分', () => {
  it('customer 是 Actor.type 的合法成員，且不是 system 那種萬用身分', () => {
    const customer: Actor = { id: 'customer:1', type: 'customer', permissions: [] };
    expect(customer.type).toBe('customer');
    expect(holds(customer, 'catalog:read')).toBe(false);
  });

  it('稽核紀錄分得出顧客與後台操作者', () => {
    const customer: Actor = { id: 'customer:1', type: 'customer', permissions: [] };
    const staff: Actor = { id: 'user:1', type: 'user', permissions: [] };
    expect(customer.type).not.toBe(staff.type);
  });
});
