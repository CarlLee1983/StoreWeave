import { bindModuleCapability, validateModuleGraph } from '@storeweave/kernel';
import { createKeyring } from '@storeweave/crypto';
import { PLATFORM_VERSION } from '@storeweave/contracts';
import { describe, expect, it } from 'vitest';
import {
  BOOKING_PROPERTY_READ_CAPABILITY, composeBookingAvailabilityRuntime,
} from '../src/module';

const property = {
  getProperty: async () => null,
  getActiveRoomType: async () => null,
  listActiveRoomTypes: async () => [],
  requireLockedQuoteFacts: async () => { throw new Error('not reached'); },
};
const propertyBinding = bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, property);
const signingSecret = Buffer.alloc(32, 7).toString('base64url');
const keyring = createKeyring({
  activeKeyId: 'runtime',
  keys: [{ id: 'runtime', secret: signingSecret }],
});

describe('Booking Availability runtime security composition', () => {
  it('requires a valid declared signing-purpose list for every runtime security hook', () => {
    const base = { name: 'security-probe', version: '1.0.0', baseVersionRange: '^1.0.0' };
    expect(() => validateModuleGraph([{ ...base, bindRuntimeSecurity: () => {} }], PLATFORM_VERSION))
      .toThrow('has bindRuntimeSecurity but declares no signing key purposes');
    expect(() => validateModuleGraph([{ ...base, runtimeSecurity: { signingKeyPurposes: ['booking-quote'] } }], PLATFORM_VERSION))
      .toThrow('declares signing key purposes but has no bindRuntimeSecurity');
    expect(() => validateModuleGraph([{
      ...base, runtimeSecurity: { signingKeyPurposes: ['not a purpose'] }, bindRuntimeSecurity: () => {},
    }], PLATFORM_VERSION)).toThrow('has invalid signing key purpose');
  });

  it('is secret-free and fails closed until a configured Keyring is bound once', () => {
    const composition = composeBookingAvailabilityRuntime(propertyBinding, { maxRoomsPerRequest: 4 });
    expect(composition.module.bindRuntimeSecurity).toBeTypeOf('function');
    expect(JSON.stringify(composition.module)).not.toContain(signingSecret);
    expect(() => composition.quoteReservation.value.revalidateAndReserve(
      {} as never, {} as never, 'booking-quote-v1:runtime:'.concat('0'.repeat(64)), new Date(),
    )).toThrow('runtime security is not bound');

    composition.module.bindRuntimeSecurity?.({ keyring });
    expect(() => composition.module.bindRuntimeSecurity?.({ keyring }))
      .toThrow('may only be bound once');
  });

  it('rejects missing security and leaves its delegates fail-closed', () => {
    const composition = composeBookingAvailabilityRuntime(propertyBinding, { maxRoomsPerRequest: 4 });
    expect(() => composition.module.bindRuntimeSecurity?.({})).toThrow('requires a configured signing Keyring');
    expect(() => composition.quoteReservation.value.revalidateAndReserve(
      {} as never, {} as never, 'booking-quote-v1:runtime:'.concat('0'.repeat(64)), new Date(),
    )).toThrow('runtime security is not bound');
  });
});
