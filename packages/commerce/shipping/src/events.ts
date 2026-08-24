import { z } from 'zod';
import { defineEvent } from '@storeweave/contracts';

const shipmentEventPayload = z.object({
  shipmentId: z.string().uuid(),
  orderId: z.string().uuid(),
  shippingMethodId: z.string().uuid(),
  occurredAt: z.coerce.date(),
});

export const shipmentCreatedV1 = defineEvent({ name: 'commerce.shipment.created.v1', summary: '物流單建立完成', payload: shipmentEventPayload });
export const shipmentShippedV1 = defineEvent({ name: 'commerce.shipment.shipped.v1', summary: '貨件已出貨', payload: shipmentEventPayload });
export const shipmentArrivedV1 = defineEvent({ name: 'commerce.shipment.arrived.v1', summary: '貨件已到店待取', payload: shipmentEventPayload });
export const shipmentCompletedV1 = defineEvent({ name: 'commerce.shipment.completed.v1', summary: '貨件已取貨或簽收', payload: shipmentEventPayload });

export const shippingEvents = [shipmentCreatedV1, shipmentShippedV1, shipmentArrivedV1, shipmentCompletedV1];
