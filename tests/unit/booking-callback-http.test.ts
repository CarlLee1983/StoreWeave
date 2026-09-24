import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_ACTOR } from '@storeweave/contracts';
import type { Runtime } from '@storeweave/kernel';
import type { ReleaseHttpAdapter } from '../../apps/api/src/release-adapter';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { BookingCallbackController } from '../../apps/api/src/controllers/booking-callback.controller';

const callbackHttpAdapter = {
  releaseId: 'booking-callback-test', anonymousRole: null,
  controllers: () => [BookingCallbackController],
  startSession: async () => null,
} satisfies ReleaseHttpAdapter;

function fixture() {
  const event = { type: 'payment_confirmed' as const, reference: 'attempt:verified-1', providerRef: 'gateway-1' };
  const parseCallback = vi.fn(async () => event);
  const acknowledgeCallback = vi.fn(({ accepted }: { accepted: boolean }) => ({
    statusCode: accepted ? 202 : 503, headers: { 'content-type': 'text/plain', 'x-gateway-ack': accepted ? 'yes' : 'no' },
    body: accepted ? 'accepted' : 'retry',
  }));
  const provider = { id: 'gateway-a', kind: 'payment' as const, parseCallback, acknowledgeCallback };
  const execute = vi.fn(async () => ({}));
  const runtime = {
    config: { http: { trustProxy: false, bodyLimitBytes: 1_048_576, cors: { allowedOrigins: [], credentials: false } }, admin: { enabled: false }, mcp: { enabled: false } },
    providers: {
      get: vi.fn((kind: string, id: string) => {
        if (kind !== 'payment' || id !== provider.id) throw new Error('unknown provider');
        return provider;
      }),
      list: () => [
        { kind: 'payment' as const, id: provider.id, owner: 'gateway-extension', isDefault: true },
        { kind: 'shipping' as const, id: 'carrier-a', owner: 'carrier-extension', isDefault: true },
      ],
    },
    commands: { execute }, logger: { info: vi.fn(), warn: vi.fn() },
  } as unknown as Runtime;
  return { runtime, parseCallback, acknowledgeCallback, execute, event };
}

describe('Booking payment callback HTTP', () => {
  it('forwards only a provider-verified payment result with one replay key and provider acknowledgement', async () => {
    const { runtime, parseCallback, execute, event } = fixture();
    const app = await createReleaseServer({ runtime, httpAdapter: callbackHttpAdapter, release: { version: 'test', configPath: '<test>' } });
    try {
      const catalog = (app.getHttpAdapter().getInstance() as { storeweaveHttpCatalog?: Array<{ kind: string; providerKinds?: string[]; targets?: Array<{ kind: string }> }> }).storeweaveHttpCatalog!;
      expect(catalog).toMatchObject([{ kind: 'provider-callback', providerKinds: ['payment'], targets: [{ kind: 'payment' }] }]);
      const request = { method: 'POST' as const, url: '/callbacks/payment/gateway-a?source=kept',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'signed=original%2Bbytes' };
      const first = await app.inject(request);
      const replay = await app.inject(request);
      expect([first.statusCode, replay.statusCode]).toEqual([202, 202]);
      expect(first.body).toBe('accepted');
      expect(first.headers['x-gateway-ack']).toBe('yes');
      expect(parseCallback).toHaveBeenCalledWith(expect.objectContaining({
        body: new TextEncoder().encode(request.payload), query: { source: 'kept' },
      }));
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenCalledWith('booking.reservation.recordVerifiedPaymentOutcome',
        { provider: 'gateway-a', event }, expect.objectContaining({ actor: SYSTEM_ACTOR,
          idempotencyKey: expect.stringMatching(/^booking-callback:[a-f0-9]{64}$/) }));
      const calls = execute.mock.calls as unknown as Array<[string, unknown, { idempotencyKey: string }]>;
      expect(calls[0]![2].idempotencyKey).toBe(calls[1]![2].idempotencyKey);
      for (const url of ['/callbacks/shipping/carrier-a', '/callbacks/payment/unknown']) {
        expect((await app.inject({ method: 'POST', url, payload: '' })).statusCode).toBe(404);
      }
    } finally {
      await app.close();
    }
  });
});
