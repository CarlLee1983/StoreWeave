import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { executeAdminOperation, type AdminOperation, type AdminOperationEntry, useAdminOperations } from './admin-operations';
import { inventoryQueryKeys, refundKeys, rmaKeys } from './query';

export type RmaOperationResource = { orderId: string; lines: { rmaLineId: string; sku: string; name: string; quantity: number }[] };
export type RmaOperation = AdminOperation & (
  | { kind: 'approve'; rmaId: string; resource: RmaOperationResource; request: { note?: string }; draft: { note: string } }
  | { kind: 'information' | 'reject'; rmaId: string; resource: RmaOperationResource; request: { reason: string }; draft: { reason: string } }
  | { kind: 'receive'; rmaId: string; resource: RmaOperationResource; request: { lines: { rmaLineId: string; disposition: 'restock' | 'discard'; discardReason?: string }[] }; draft: { lines: { rmaLineId: string; disposition: 'restock' | 'discard'; discardReason: string }[] } }
  | { kind: 'refund'; rmaId: string; resource: RmaOperationResource; request: { reason?: string }; draft: { reason: string } }
  | { kind: 'retry-refund'; rmaId: string; resource: RmaOperationResource; request: { refundId: string }; draft: Record<never, never> }
);

export const rmaScope = (id: string) => `rma:${id}`;
export function isRmaOperationEntry(entry: AdminOperationEntry): entry is AdminOperationEntry<RmaOperation> {
  return entry.operation.area === 'rma' && entry.operation.scope.startsWith('rma:') && 'kind' in entry.operation
    && ['approve', 'information', 'reject', 'receive', 'refund', 'retry-refund'].includes(String(entry.operation.kind));
}

export function isRmaReasonOperation(operation: RmaOperation): operation is Extract<RmaOperation, { kind: 'information' | 'reject' }> {
  return operation.kind === 'information' || operation.kind === 'reject';
}

export function dispatchRmaOperation(operation: RmaOperation) {
  switch (operation.kind) {
    case 'approve': return api.approveRma(operation.rmaId, operation.request.note, operation.idempotencyKey);
    case 'information': return api.requestRmaInformation(operation.rmaId, operation.request.reason, operation.idempotencyKey);
    case 'reject': return api.rejectRma(operation.rmaId, operation.request.reason, operation.idempotencyKey);
    case 'receive': return api.receiveRma(operation.rmaId, operation.request.lines, operation.idempotencyKey);
    case 'refund': return api.requestRmaRefund(operation.rmaId, operation.request.reason, operation.idempotencyKey);
    case 'retry-refund': return api.retryRefund(operation.request.refundId, operation.idempotencyKey);
  }
}
export function rmaInvalidationKeys(operation: RmaOperation) {
  const keys: (readonly unknown[])[] = [rmaKeys.lists];
  if (operation.kind === 'refund' || operation.kind === 'retry-refund') keys.push(refundKeys.lists);
  if (operation.kind === 'receive' && operation.request.lines.some((line) => line.disposition === 'restock')) keys.push(inventoryQueryKeys.lists);
  return keys;
}

export function useRmaCommand() {
  const store = useAdminOperations();
  const queryClient = useQueryClient();
  const mutation = useMutation<unknown, unknown, RmaOperation>({ mutationKey: ['rma', 'command'] as const, mutationFn: dispatchRmaOperation });
  return (operation: RmaOperation, retryEntry?: AdminOperationEntry<RmaOperation>) => executeAdminOperation<RmaOperation, unknown>(store, operation, mutation.mutateAsync, (_result, live) => {
    rmaInvalidationKeys(live).forEach((queryKey) => { void queryClient.invalidateQueries({ queryKey }); });
    return undefined;
  }, retryEntry);
}
