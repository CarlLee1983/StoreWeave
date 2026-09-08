import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type AdminCustomer } from './api';
import { executeAdminOperation, type AdminOperation, type AdminOperationEntry, useAdminOperations } from './admin-operations';
import { analyticsKeys, customerKeys, loyaltyKeys } from './query';

export type CustomerOperation = AdminOperation & (
  | { kind: 'status'; customerId: string; request: { status: AdminCustomer['status'] }; draft: { status: AdminCustomer['status'] } }
  | { kind: 'birthday'; customerId: string; request: { birthday: string; reason: string }; draft: { birthday: string; reason: string } }
  | { kind: 'rewards'; customerId: string; request: { amountCents: number; reason: string }; draft: { amount: string; reason: string; currency: string } }
  | { kind: 'tier-points'; customerId: string; request: { points: number; reason: string }; draft: { points: string; reason: string } }
);
export const customerScope = { profile: (id: string) => `customer-profile:${id}`, rewards: (id: string) => `customer-rewards:${id}`, tierPoints: (id: string) => `customer-tier-points:${id}` };
export function isCustomerOperationEntry(entry: AdminOperationEntry): entry is AdminOperationEntry<CustomerOperation> {
  return entry.operation.area === 'customer' && 'kind' in entry.operation && ['status', 'birthday', 'rewards', 'tier-points'].includes(String(entry.operation.kind));
}
export function customerInvalidationKeys(operation: CustomerOperation) {
  switch (operation.kind) {
    case 'status':
    case 'birthday': return [customerKeys.lists, customerKeys.detail(operation.customerId)];
    case 'rewards': return [loyaltyKeys.customer(operation.customerId), analyticsKeys.outstandingRewards];
    case 'tier-points': return [loyaltyKeys.customer(operation.customerId)];
  }
}
type CustomerResult = AdminCustomer | Omit<AdminCustomer, 'email'> | { id: string } | { points: number };
function dispatch(operation: CustomerOperation): Promise<CustomerResult> {
  switch (operation.kind) {
    case 'status': return api.setCustomerStatus(operation.customerId, operation.request.status, operation.idempotencyKey);
    case 'birthday': return api.correctCustomerBirthday(operation.customerId, operation.request, operation.idempotencyKey);
    case 'rewards': return api.adjustRewards(operation.customerId, operation.request, operation.idempotencyKey);
    case 'tier-points': return api.adjustTierPoints(operation.customerId, operation.request, operation.idempotencyKey);
  }
}
export function useCustomerCommand() {
  const store = useAdminOperations();
  const queryClient = useQueryClient();
  const mutation = useMutation<CustomerResult, unknown, CustomerOperation>({ mutationKey: ['customer', 'command'] as const, mutationFn: dispatch });
  return (operation: CustomerOperation, retryEntry?: AdminOperationEntry<CustomerOperation>) => executeAdminOperation(store, operation, mutation.mutateAsync, (_result, live) => {
    customerInvalidationKeys(live).forEach((queryKey) => { void queryClient.invalidateQueries({ queryKey }); });
    return undefined;
  }, retryEntry);
}
