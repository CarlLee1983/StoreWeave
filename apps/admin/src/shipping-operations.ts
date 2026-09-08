import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type EcpayLogisticsShipmentOperation, type Shipment, type ShippingMethod } from './api';
import { executeAdminOperation, type AdminOperation, type AdminOperationEntry, useAdminOperations } from './admin-operations';
import { deadJobKeys, lifecycleDeliveryKeys, shipmentKeys, shipmentOperationKeys, shippingMethodKeys } from './query';

type ShippingMethodCreateRequest = { code: string; name: string; provider: string; type: string; destinationKind: ShippingMethod['destinationKind']; feeCents: number; freeShippingThresholdCents?: number; enabled: boolean };
type ShippingMethodUpdateRequest = { name: string; provider: string; type: string; destinationKind: ShippingMethod['destinationKind']; feeCents: number; freeShippingThresholdCents?: number | null; enabled: boolean };
export type ShippingMethodCreateDraft = { code: string; name: string; provider: string; type: string; destinationKind: ShippingMethod['destinationKind']; feeCents: string; freeShippingThresholdCents: string; enabled: boolean };
export type ShippingMethodUpdateDraft = Omit<ShippingMethodCreateDraft, 'code'>;
export type ShippingOperation = AdminOperation & (
  | { kind: 'create-method'; request: ShippingMethodCreateRequest; draft: ShippingMethodCreateDraft }
  | { kind: 'update-method'; methodId: string; request: ShippingMethodUpdateRequest; draft: ShippingMethodUpdateDraft }
  | { kind: 'create-shipment'; orderId: string; request: { orderId: string }; draft: { orderId: string } }
  | { kind: 'advance-shipment'; shipmentId: string; request: { status: Exclude<Shipment['status'], 'created'> }; draft: { status: Exclude<Shipment['status'], 'created'> } }
  | { kind: 'retry-ecpay'; shipmentId: string; request: { shipmentId: string }; draft: Record<never, never> }
);

export const shippingScope = { methodCreate: 'shipping-method:create', method: (id: string) => `shipping-method:${id}`, order: (id: string) => `order:${id}`, shipment: (id: string) => `shipment:${id}` };
export function isShippingOperationEntry(entry: AdminOperationEntry): entry is AdminOperationEntry<ShippingOperation> {
  return entry.operation.area === 'shipping' && 'kind' in entry.operation && ['create-method', 'update-method', 'create-shipment', 'advance-shipment', 'retry-ecpay'].includes(String(entry.operation.kind));
}
export function shippingInvalidationKeys(result: ShippingMethod | Shipment | EcpayLogisticsShipmentOperation, operation: ShippingOperation) {
  switch (operation.kind) {
    case 'create-method':
    case 'update-method': return [shippingMethodKeys.lists];
    case 'create-shipment': {
      const shipment = result as Shipment;
      return shipment.provider === 'ecpay-logistics'
        ? [shipmentKeys.detail(shipment.id), shipmentOperationKeys.lists, shipmentOperationKeys.detail(shipment.id)]
        : [shipmentKeys.detail(shipment.id)];
    }
    case 'advance-shipment': return operation.request.status === 'shipped' || operation.request.status === 'arrived'
      ? [shipmentKeys.detail(operation.shipmentId), lifecycleDeliveryKeys.lists]
      : [shipmentKeys.detail(operation.shipmentId)];
    case 'retry-ecpay': return [shipmentOperationKeys.lists, shipmentOperationKeys.detail(operation.shipmentId), shipmentKeys.detail(operation.shipmentId), deadJobKeys.lists];
  }
}

function dispatch(operation: ShippingOperation): Promise<ShippingMethod | Shipment | EcpayLogisticsShipmentOperation> {
  switch (operation.kind) {
    case 'create-method': return api.createShippingMethod(operation.request, operation.idempotencyKey);
    case 'update-method': return api.updateShippingMethod(operation.methodId, operation.request, operation.idempotencyKey);
    case 'create-shipment': return api.createShipment(operation.request, operation.idempotencyKey);
    case 'advance-shipment': return api.advanceShipmentStage(operation.shipmentId, operation.request.status, operation.idempotencyKey);
    case 'retry-ecpay': return api.retryEcpayLogisticsShipment(operation.shipmentId, operation.idempotencyKey);
  }
}

export function useShippingCommand() {
  const store = useAdminOperations();
  const queryClient = useQueryClient();
  const mutation = useMutation<ShippingMethod | Shipment | EcpayLogisticsShipmentOperation, unknown, ShippingOperation>({ mutationKey: ['shipping', 'command'] as const, mutationFn: dispatch });
  return (operation: ShippingOperation, retryEntry?: AdminOperationEntry<ShippingOperation>) => executeAdminOperation(store, operation, mutation.mutateAsync, (result, live) => {
    shippingInvalidationKeys(result, live).forEach((queryKey) => { void queryClient.invalidateQueries({ queryKey }); });
    return undefined;
  }, retryEntry);
}
