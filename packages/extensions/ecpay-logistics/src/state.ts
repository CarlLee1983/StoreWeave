import { z } from 'zod';

export const shipmentOperationStatus = z.enum(['pending', 'created', 'failed']);
export const shipmentLifecycleStage = z.enum(['created', 'shipped', 'arrived', 'completed']);

/**
 * Extension-owned operational state: it contains no destination, label handle,
 * raw carrier response, or credentials. Shipping owns the durable normalized
 * shipment evidence and its audit entry; this record makes retry state visible
 * to operators. A future live-wire retention policy must be UAT-reviewed.
 */
export const shipmentOperationRecord = z.object({
  shipmentId: z.string().uuid(),
  orderId: z.string().uuid(),
  reference: z.string().min(1),
  status: shipmentOperationStatus,
  attempts: z.number().int().nonnegative(),
  manualRetries: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  providerRef: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  labelAvailable: z.boolean(),
  /** Latest provider-neutral lifecycle mapping; raw carrier state stays in Shipping only. */
  lastKnownStage: shipmentLifecycleStage.default('created'),
  lastStatusQueriedAt: z.string().nullable().default(null),
  lastStatusQueryError: z.string().nullable().default(null),
  jobId: z.string().nullable(),
  firstSeenAt: z.string(),
  updatedAt: z.string(),
});
export type ShipmentOperationRecord = z.infer<typeof shipmentOperationRecord>;

/** Safe operator projection: the platform reference stays internal to the extension. */
export const shipmentOperationDto = shipmentOperationRecord.omit({ reference: true });
export type ShipmentOperationDto = z.infer<typeof shipmentOperationDto>;

export function operationKey(shipmentId: string): string {
  return `shipment-operation:${shipmentId}`;
}
