import type { OrderAdjustmentDto, OrderDeliveryDto, OrderDto, OrderLineDto } from './dto';

/** Browser-safe staff projection of the JSON emitted by the Order HTTP endpoints. */
export type AdminOrderStatus = OrderDto['status'];
export type AdminOrderAdjustmentSource = OrderAdjustmentDto['source'];

export type AdminOrderLine = OrderLineDto;

export type AdminOrderAdjustment = OrderAdjustmentDto;

export type AdminOrderDelivery = Omit<OrderDeliveryDto, 'createdAt' | 'destination'> & {
  destination: Record<string, unknown>;
  createdAt: string;
};

export type AdminOrder = Pick<OrderDto,
  'id' | 'number' | 'status' | 'currency' | 'customerEmail' |
  'subtotalCents' | 'discountCents' | 'shippingCents' | 'taxCents' | 'totalCents'
> & {
  lines: AdminOrderLine[];
  adjustments: AdminOrderAdjustment[];
  delivery: AdminOrderDelivery | null;
  placedAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
  expiresAt: string | null;
};
