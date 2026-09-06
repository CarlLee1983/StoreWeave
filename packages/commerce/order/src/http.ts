import type { OrderAdjustmentSource, OrderStatus } from './contract';

/** Browser-safe staff projection of the JSON emitted by the Order HTTP endpoints. */
export type AdminOrderStatus = OrderStatus;
export type AdminOrderAdjustmentSource = OrderAdjustmentSource;

export type AdminOrderLine = {
  id: string;
  productId: string;
  sku: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
  discountCents: number;
};

export type AdminOrderAdjustment = {
  source: AdminOrderAdjustmentSource;
  sourceId: string;
  name: string;
  amountCents: number;
};

export type AdminOrderDelivery = {
  shippingMethodId: string;
  shippingMethodCode: string;
  shippingMethodName: string;
  provider: string;
  type: string;
  destinationKind: 'taiwan_home' | 'pickup_store';
  destination: Record<string, unknown>;
  createdAt: string;
};

export type AdminOrder = {
  id: string;
  number: string;
  status: AdminOrderStatus;
  currency: string;
  customerEmail: string;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  lines: AdminOrderLine[];
  adjustments: AdminOrderAdjustment[];
  delivery: AdminOrderDelivery | null;
  placedAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
  expiresAt: string | null;
};
