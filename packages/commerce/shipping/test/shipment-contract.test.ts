import { describe, expect, it } from 'vitest';
import { shippingDestinationInput } from '../src/dto';
import { shipmentArrivedV1, shipmentCompletedV1, shipmentCreatedV1, shipmentShippedV1 } from '../src/events';
import { toShipmentDto, toShippingMethodDto } from '../src/repository';

const createdAt = new Date('2026-08-24T00:00:00.000Z');

describe('shipment public contract', () => {
  it('accepts only complete, provider-neutral checkout destinations', () => {
    expect(shippingDestinationInput.safeParse({
      kind: 'taiwan_home', countryCode: 'TW', recipient: '王小明', phone: '0912345678',
      postcode: '100', city: '台北市', district: '中正區', line1: '忠孝西路一段 1 號', line2: null,
    }).success).toBe(true);
    expect(shippingDestinationInput.safeParse({
      kind: 'pickup_store', providerStoreId: '12345', storeName: '便利店', storeAddress: '台北市中正區',
      recipient: '王小明', phone: '0912345678', extra: 'not accepted',
    }).success).toBe(false);
  });

  it('exposes method destination compatibility to checkout', () => {
    const dto = toShippingMethodDto({
      id: '3f0f2e36-bc2a-497c-9e6e-955039a00df9', code: 'home', name: '宅配', provider: 'carrier',
      type: 'home_delivery', destinationKind: 'taiwan_home', feeCents: 60, freeShippingThresholdCents: 800,
      enabled: true, createdAt, updatedAt: createdAt,
    });
    expect(dto.destinationKind).toBe('taiwan_home');
  });

  it('maps provider status evidence out of the public DTO', () => {
    const dto = toShipmentDto({
      id: '8dd4b616-2045-4549-96cb-5063111797fd',
      orderId: 'cf9dceea-2738-4de2-b240-81d4d79696f7',
      shippingMethodId: 'cc732d77-a682-4ed4-a3db-95688525f3cc',
      provider: 'carrier', type: 'home_delivery', providerRef: 'remote-123', trackingNumber: 'track-123',
      status: 'shipped', providerStatusRaw: 'carrier-in-transit',
      createdAt, shippedAt: createdAt, arrivedAt: null, completedAt: null, updatedAt: createdAt,
    });

    expect(dto).not.toHaveProperty('providerStatusRaw');
    expect(dto.status).toBe('shipped');
  });

  it('declares only domain-stage shipment events', () => {
    expect([shipmentCreatedV1, shipmentShippedV1, shipmentArrivedV1, shipmentCompletedV1].map((event) => event.name)).toEqual([
      'commerce.shipment.created.v1',
      'commerce.shipment.shipped.v1',
      'commerce.shipment.arrived.v1',
      'commerce.shipment.completed.v1',
    ]);
  });
});
