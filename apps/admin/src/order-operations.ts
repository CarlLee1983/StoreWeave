import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Order, type Refund } from './api';
import { executeAdminOperation, type AdminOperation, type AdminOperationEntry, useAdminOperations } from './admin-operations';
import { analyticsKeys, couponKeys, customerKeys, erpDeliveryKeys, inventoryQueryKeys, invoiceKeys, lifecycleDeliveryKeys, loyaltyKeys, orderKeys, refundKeys, rmaKeys } from './query';

export type OrderOperation = AdminOperation & (
  | { kind: 'pay'; orderId: string; request: Record<never, never>; draft: Record<never, never> }
  | { kind: 'cancel'; orderId: string; request: { reason: string }; draft: { reason: string } }
  | { kind: 'refund'; orderId: string; request: { reason: string }; draft: { reason: string } }
  | { kind: 'retry-refund'; refundId: string; request: Record<never, never>; draft: Record<never, never> }
);
export const orderScope = (id: string) => `order:${id}`;
export const refundScope = (id: string) => `refund:${id}`;
export function isOrderOperationEntry(entry: AdminOperationEntry): entry is AdminOperationEntry<OrderOperation> {
  return entry.operation.area === 'order' && 'kind' in entry.operation && ['pay', 'cancel', 'refund', 'retry-refund'].includes(String(entry.operation.kind));
}
function dispatch(operation: OrderOperation): Promise<Order | Refund> {
  switch (operation.kind) {
    case 'pay': return api.payOrder(operation.orderId, operation.idempotencyKey);
    case 'cancel': return api.cancelOrder(operation.orderId, operation.request.reason, operation.idempotencyKey);
    case 'refund': return api.requestRefund(operation.orderId, operation.request.reason, operation.idempotencyKey);
    case 'retry-refund': return api.retryRefund(operation.refundId, operation.idempotencyKey);
  }
}
export function orderInvalidationKeys(result: Order | Refund, operation: OrderOperation) {
  if (operation.kind === 'refund') return [refundKeys.lists];
  if (operation.kind === 'retry-refund') return [refundKeys.lists, rmaKeys.lists];
  const keys: (readonly unknown[])[] = [orderKeys.lists, orderKeys.detail(operation.orderId), customerKeys.details];
  if (operation.kind === 'pay') keys.push(analyticsKeys.salesSummaries);
  if (operation.kind === 'pay' && 'number' in result && result.status === 'paid') keys.push(inventoryQueryKeys.lists, loyaltyKeys.customers, analyticsKeys.outstandingRewards, invoiceKeys.lists, lifecycleDeliveryKeys.lists, erpDeliveryKeys.lists);
  if (operation.kind === 'cancel') keys.push(inventoryQueryKeys.lists, couponKeys.lists, loyaltyKeys.customers, analyticsKeys.outstandingRewards, analyticsKeys.salesSummaries, analyticsKeys.promotionPerformances, analyticsKeys.partnerPerformances);
  return keys;
}
export function useOrderCommand() {
  const store = useAdminOperations();
  const queryClient = useQueryClient();
  const mutation = useMutation<Order | Refund, unknown, OrderOperation>({ mutationKey: ['order', 'command'] as const, mutationFn: dispatch });
  return (operation: OrderOperation, retryEntry?: AdminOperationEntry<OrderOperation>) => executeAdminOperation(store, operation, mutation.mutateAsync, (result, live) => {
    orderInvalidationKeys(result, live).forEach((queryKey) => { void queryClient.invalidateQueries({ queryKey }); });
    return undefined;
  }, retryEntry);
}
