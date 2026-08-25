import { describe, expect, it } from 'vitest';
import { recordProviderCallbackInput, recordProviderShipmentInput, shippingDestinationInput } from '../src/dto';
import { shipmentArrivedV1, shipmentCompletedV1, shipmentCreatedV1, shipmentShippedV1 } from '../src/events';
import { toProviderShipmentRequestDto, toShipmentDto, toShipmentLabelInfoDto, toShippingMethodDto } from '../src/repository';

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

  it('keeps carrier request, label handle, and raw provider evidence out of the public DTO', () => {
    const row = {
      id: '8dd4b616-2045-4549-96cb-5063111797fd',
      orderId: 'cf9dceea-2738-4de2-b240-81d4d79696f7',
      shippingMethodId: 'cc732d77-a682-4ed4-a3db-95688525f3cc',
      provider: 'carrier', type: 'home_delivery', serviceCode: 'carrier-home',
      destinationSnapshot: {
        kind: 'taiwan_home' as const, countryCode: 'TW' as const, recipient: '王小明', phone: '0912345678',
        postcode: '100', city: '台北市', district: '中正區', line1: '忠孝西路一段 1 號', line2: null,
      },
      providerRequestRef: 'shipment:8dd4b616-2045-4549-96cb-5063111797fd',
      providerOwner: 'carrier-extension',
      providerRef: 'remote-123', trackingNumber: 'track-123', trackingUrl: 'https://carrier.example.test/track/track-123', labelReference: 'LABEL-123',
      status: 'shipped', providerStatusRaw: 'carrier-in-transit', providerCallbackRaw: 'c2lnbmVkLWNvdXJpZXItcGF5bG9hZA==',
      createdAt, shippedAt: createdAt, arrivedAt: null, completedAt: null, updatedAt: createdAt,
    };
    const dto = toShipmentDto(row);

    expect(dto).not.toHaveProperty('providerStatusRaw');
    expect(dto).not.toHaveProperty('providerCallbackRaw');
    expect(dto).not.toHaveProperty('destinationSnapshot');
    expect(dto).not.toHaveProperty('providerRequestRef');
    expect(dto).not.toHaveProperty('labelReference');
    expect(dto.trackingUrl).toBe('https://carrier.example.test/track/track-123');
    expect(dto.status).toBe('shipped');

    expect(toProviderShipmentRequestDto(row)).toMatchObject({
      shipmentId: row.id, provider: 'carrier', serviceCode: 'carrier-home', reference: row.providerRequestRef,
      destination: { recipient: '王小明' },
    });
    expect(toShipmentLabelInfoDto(row)).toEqual({
      shipmentId: row.id, provider: 'carrier', providerRef: 'remote-123', labelReference: 'LABEL-123',
    });
  });

  it('accepts only an opaque local label reference, never an upstream URL', () => {
    const input = {
      shipmentId: '8dd4b616-2045-4549-96cb-5063111797fd', provider: 'carrier',
      reference: 'shipment:8dd4b616-2045-4549-96cb-5063111797fd', providerRef: 'remote-123',
    };
    expect(recordProviderShipmentInput.safeParse({ ...input, labelReference: 'LABEL-123' }).success).toBe(true);
    expect(recordProviderShipmentInput.safeParse({ ...input, labelReference: 'https://carrier.example/label?secret=x' }).success).toBe(false);
  });

  it('accepts only a credential-free HTTPS tracking page from a verified callback', () => {
    const callback = {
      provider: 'carrier', providerRef: 'remote-123', rawStatus: 'carrier-arrived', callbackId: 'event-1',
      callbackPayloadBase64: 'c2lnbmVkLWNvdXJpZXItcGF5bG9hZA==',
      stage: 'arrived' as const,
    };
    expect(recordProviderCallbackInput.safeParse({ ...callback, trackingUrl: 'https://carrier.example.test/track/123' }).success).toBe(true);
    expect(recordProviderCallbackInput.safeParse({ ...callback, trackingUrl: 'http://carrier.example.test/track/123' }).success).toBe(false);
    expect(recordProviderCallbackInput.safeParse({ ...callback, trackingUrl: 'https://token@carrier.example.test/track/123' }).success).toBe(false);
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
