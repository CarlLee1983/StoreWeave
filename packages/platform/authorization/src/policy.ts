import type { Actor } from '@storeweave/contracts';

export type PolicyDecision = 'allow' | 'deny' | 'abstain';

export interface PolicyEvaluationInput {
  readonly actor: Actor;
  readonly permission: string;
  readonly resource?: { type: string; id?: string; attributes?: Record<string, unknown> };
}

export interface PolicyDefinition {
  readonly id: string;
  /** 只在這些 permission 上觸發；空陣列代表全部。 */
  readonly appliesTo: readonly string[];
  readonly owner: string;
  evaluate(input: PolicyEvaluationInput): PolicyDecision;
  readonly reason?: string;
}

/**
 * Policy Registry：Extension 可以加上額外限制。
 * 決策規則為 deny-overrides —— 任一 policy 回 deny 就拒絕；policy 不能把沒有的權限變成有。
 */
export class PolicyRegistry {
  private readonly policies: PolicyDefinition[] = [];

  register(policy: PolicyDefinition): void {
    if (this.policies.some((p) => p.id === policy.id)) {
      throw new Error(`Policy "${policy.id}" already registered`);
    }
    this.policies.push(policy);
  }

  list(): readonly PolicyDefinition[] {
    return this.policies;
  }

  evaluate(input: PolicyEvaluationInput): { decision: 'allow' | 'deny'; policyId?: string; reason?: string } {
    for (const p of this.policies) {
      if (p.appliesTo.length > 0 && !p.appliesTo.includes(input.permission)) continue;
      if (p.evaluate(input) === 'deny') {
        return { decision: 'deny', policyId: p.id, reason: p.reason };
      }
    }
    return { decision: 'allow' };
  }
}
