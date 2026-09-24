import { describe, expect, it, vi } from 'vitest';
import type { Runtime } from '@storeweave/kernel';
import type { ReleaseHttpAdapter } from '../../apps/api/src/release-adapter';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { BookingOperatorController } from '../../apps/api/src/controllers/booking-operator.controller';
import { SESSION_COOKIE, cookieName } from '../../apps/api/src/http/cookie-names';

const operatorHttpAdapter = {
  releaseId: 'booking-operator-test', anonymousRole: null,
  controllers: () => [BookingOperatorController], startSession: async () => null,
} satisfies ReleaseHttpAdapter;

describe('Booking operator HTTP', () => {
  it('mounts an explicit Reservation list route and uses the authenticated human Actor', async () => {
    const actor = { id: 'user:booking-operator', type: 'user' as const, displayName: 'Operator', permissions: ['booking-reservation:operator-read'] };
    const execute = vi.fn(async () => ({ items: [], total: 0 }));
    const runtime = {
      config: { http: { publicUrl: 'https://booking.example.test', trustProxy: false, bodyLimitBytes: 1_048_576, cors: { allowedOrigins: [], credentials: false } }, admin: { enabled: false }, mcp: { enabled: false } },
      auth: { resolveSession: vi.fn(async () => ({ actor })) }, database: { db: {} },
      queries: { execute, get: () => ({ owner: 'booking-operator-test', descriptor: { permission: 'booking-reservation:operator-read' } }) },
      commands: { get: () => ({ owner: 'booking-operator-test', descriptor: { permission: 'booking-reservation:manage', idempotency: 'required' } }) },
    } as unknown as Runtime;
    const app = await createReleaseServer({ runtime, httpAdapter: operatorHttpAdapter, release: { version: 'test', configPath: '<test>' } });
    try {
      const response = await app.inject({ url: '/api/v1/booking/operator/reservations?limit=2&offset=3',
        cookies: { [cookieName(SESSION_COOKIE, 'https://booking.example.test')]: 'session' } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().data).toEqual({ items: [], total: 0 });
      expect(execute).toHaveBeenCalledWith('booking.reservation.listOperator', { limit: 2, offset: 3 },
        expect.objectContaining({ actor, channel: 'rest' }));
    } finally {
      await app.close();
    }
  });
});
