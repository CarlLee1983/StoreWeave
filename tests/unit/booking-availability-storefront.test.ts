import 'reflect-metadata';
import { PlatformError, type Actor } from '@storeweave/contracts';
import { type ThemeContext } from '@storeweave/kernel';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { bookingAvailabilityPages } from '../../packages/booking/availability/src/pages';
import { bookingDefaultTheme } from '../../packages/themes/booking-default/src/index';
import { createStorefrontController } from '../../apps/api/src/storefront/storefront-routes';

const visitor: Actor = {
  id: 'visitor:test', type: 'service', displayName: 'visitor', permissions: ['booking-availability:quote'],
};
const themeContext: ThemeContext = {
  storeName: '旅店', storeId: 'booking-test', locale: 'zh-TW', timeZone: 'Asia/Taipei',
  publicUrl: 'https://booking.example.test', options: {}, navigation: {},
};

function createRoute(execute: ReturnType<typeof vi.fn>, errorViews: Array<{ status: number; body: string }>) {
  const controller = createStorefrontController(Object.values(bookingAvailabilityPages), {
    theme: bookingDefaultTheme,
    buildContext: async () => themeContext,
    resolveContext: () => ({
      queries: { execute }, commands: { execute: vi.fn() }, actor: visitor, locale: 'zh-TW', clientKey: 'test',
      cookies: { guestCartToken: () => null, ensureGuestCart: () => 'unused' },
      providers: { get: vi.fn(), has: vi.fn() },
    }),
    sessionEffects: { start: vi.fn(), clear: vi.fn() },
    renderError: async (_req, reply, error) => {
      const status = error instanceof PlatformError ? error.httpStatus : 500;
      const message = error instanceof PlatformError && status < 500 ? error.message : '發生未預期的錯誤';
      const body = bookingDefaultTheme.renderers['platform.error'](themeContext, { status, message });
      errorViews.push({ status, body });
      void reply.status(status).header('content-type', 'text/html; charset=utf-8').send(body);
    },
  });
  return controller;
}

function replyStub() {
  const response: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const reply = {
    status(code: number) { response.status = code; return reply; },
    header(name: string, value: string) { response.headers[name] = value; return reply; },
    send(body: unknown) { response.body = body; return reply; },
  };
  return { reply, response };
}

function handler(controller: Function, pageId: string) {
  return (controller.prototype as Record<string, unknown>)[`page_${pageId.replace(/[^A-Za-z0-9]/g, '_')}`] as Function;
}

describe('Booking Availability public storefront routes', () => {
  it('turns malformed public GET input into an HTML 400 validation view', async () => {
    const execute = vi.fn();
    const controller = createRoute(execute, []);
    const { reply, response } = replyStub();
    await handler(controller, 'booking.availability.search').call(new (controller as new () => object)(), {
      actor: visitor,
      query: { checkInLocalDate: 'bad', checkOutLocalDate: '2026-10-03', adults: '2', children: '0', roomCount: '1' },
    }, reply);

    expect(execute).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toContain('booking-validation');
    expect(response.body).toContain('Expected a canonical calendar date');
  });

  it('allows a public visitor actor with the Booking quote grant to call the read query', async () => {
    const execute = vi.fn().mockResolvedValue({ kind: 'unavailable' });
    const controller = createRoute(execute, []);
    const { reply, response } = replyStub();
    await handler(controller, 'booking.availability.search').call(new (controller as new () => object)(), {
      actor: visitor,
      query: { checkInLocalDate: '2026-10-01', checkOutLocalDate: '2026-10-03', adults: '2', children: '0', roomCount: '1' },
    }, reply);

    expect(execute).toHaveBeenCalledWith('booking.availability.searchQuotes', expect.any(Object), { actor: visitor });
    expect(response.status).toBe(200);
    expect(response.body).toContain('目前沒有符合條件且可預訂的房型');
  });

  it('sends authorization and internal failures to the platform.error renderer', async () => {
    const errorViews: Array<{ status: number; body: string }> = [];
    const execute = vi.fn().mockRejectedValue(PlatformError.forbidden('Missing quote permission'));
    const controller = createRoute(execute, errorViews);
    const invoke = async () => {
      const { reply, response } = replyStub();
      await handler(controller, 'booking.availability.quote').call(new (controller as new () => object)(), {
        actor: visitor,
        query: {
          roomTypeId: '81a8ae9d-5096-48b8-8b59-af3c7a14ce02', checkInLocalDate: '2026-10-01',
          checkOutLocalDate: '2026-10-03', adults: '2', children: '0', roomCount: '1',
        },
      }, reply);
      return response;
    };

    const forbidden = await invoke();
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toContain('Missing quote permission');
    expect(errorViews).toHaveLength(1);

    execute.mockRejectedValue(new Error('internal dependency detail'));
    const internal = await invoke();
    expect(internal.status).toBe(500);
    expect(internal.body).toContain('發生未預期的錯誤');
    expect(internal.body).not.toContain('internal dependency detail');

    execute.mockRejectedValue(new ZodError([{ code: 'custom', path: [], message: 'internal output schema failure' }]));
    const invalidOutput = await invoke();
    expect(invalidOutput.status).toBe(500);
    expect(invalidOutput.body).toContain('發生未預期的錯誤');
    expect(invalidOutput.body).not.toContain('internal output schema failure');
    expect(errorViews).toHaveLength(3);
  });
});
