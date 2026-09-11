import { PlatformError, type Actor } from '@storeweave/contracts';
import { PermissionRegistry } from './permissions';
import { PolicyRegistry, type PolicyEvaluationInput } from './policy';

/**
 * actor 是否持有這個權限鍵（含 `*` 與 `scope:*`），不評估 policy。
 * 需要自己依權限限縮範圍的 handler 用它，而不是各寫一份比對。
 */
export function actorHolds(actor: Actor, permission: string): boolean {
  if (actor.type === 'system') return true;
  for (const granted of actor.permissions) {
    if (granted === '*' || granted === permission) return true;
    // `catalog:*` 這種 scope wildcard
    if (granted.endsWith(':*') && permission.startsWith(granted.slice(0, -1))) return true;
  }
  return false;
}

export class AuthorizationService {
  constructor(
    readonly permissions: PermissionRegistry = new PermissionRegistry(),
    readonly policies: PolicyRegistry = new PolicyRegistry(),
  ) {}

  private holds(actor: Actor, permission: string): boolean {
    return actorHolds(actor, permission);
  }

  check(input: PolicyEvaluationInput): { allowed: boolean; reason?: string } {
    if (!this.holds(input.actor, input.permission)) {
      return { allowed: false, reason: `missing permission ${input.permission}` };
    }
    const policy = this.policies.evaluate(input);
    if (policy.decision === 'deny') {
      return { allowed: false, reason: policy.reason ?? `denied by policy ${policy.policyId}` };
    }
    return { allowed: true };
  }

  assert(input: PolicyEvaluationInput): void {
    const result = this.check(input);
    if (!result.allowed) {
      throw PlatformError.forbidden(`Forbidden: ${result.reason}`);
    }
  }
}
