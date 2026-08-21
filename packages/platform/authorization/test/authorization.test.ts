import { describe, expect, it } from 'vitest';
import { AuthorizationService, PermissionRegistry, PolicyRegistry } from '@storeweave/authorization';
import { PlatformError, SYSTEM_ACTOR, type Actor } from '@storeweave/contracts';

function service() {
  const permissions = new PermissionRegistry();
  permissions.registerMany([
    { key: 'catalog:read', description: 'r', owner: 'catalog' },
    { key: 'catalog:write', description: 'w', owner: 'catalog' },
    { key: 'order:write', description: 'w', owner: 'order' },
  ]);
  return new AuthorizationService(permissions, new PolicyRegistry());
}

const staff: Actor = { id: 'u1', type: 'user', permissions: ['catalog:read'] };

describe('PermissionRegistry', () => {
  it('拒絕格式錯誤的 permission key', () => {
    expect(() => new PermissionRegistry().register({ key: 'Bad Key', description: '', owner: 'x' })).toThrow(PlatformError);
  });

  it('同一個 key 被不同 owner 宣告時拋錯', () => {
    const r = new PermissionRegistry();
    r.register({ key: 'a:read', description: '', owner: 'one' });
    expect(() => r.register({ key: 'a:read', description: '', owner: 'two' })).toThrow(/already declared/);
  });
});

describe('AuthorizationService', () => {
  it('允許持有權限的 actor', () => {
    expect(service().check({ actor: staff, permission: 'catalog:read' }).allowed).toBe(true);
  });

  it('擋掉沒有權限的 actor', () => {
    const result = service().check({ actor: staff, permission: 'catalog:write' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('catalog:write');
  });

  it('system actor 一律通過', () => {
    expect(service().check({ actor: SYSTEM_ACTOR, permission: 'order:write' }).allowed).toBe(true);
  });

  it('支援 scope wildcard', () => {
    const actor: Actor = { id: 'u2', type: 'user', permissions: ['catalog:*'] };
    expect(service().check({ actor, permission: 'catalog:write' }).allowed).toBe(true);
    expect(service().check({ actor, permission: 'order:write' }).allowed).toBe(false);
  });

  it('policy 可以否決，但不能給出沒有的權限', () => {
    const svc = service();
    svc.policies.register({
      id: 'no-read-on-friday',
      appliesTo: ['catalog:read'],
      owner: 'test-ext',
      reason: 'blocked by test policy',
      evaluate: () => 'deny',
    });
    expect(svc.check({ actor: staff, permission: 'catalog:read' }).allowed).toBe(false);

    svc.policies.register({ id: 'grant-all', appliesTo: [], owner: 'test-ext', evaluate: () => 'allow' });
    expect(svc.check({ actor: staff, permission: 'catalog:write' }).allowed).toBe(false);
  });

  it('assert 失敗時拋 FORBIDDEN', () => {
    expect(() => service().assert({ actor: staff, permission: 'catalog:write' })).toThrow(/Forbidden/);
  });
});
