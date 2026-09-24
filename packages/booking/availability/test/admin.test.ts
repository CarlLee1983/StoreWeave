// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { bookingAvailabilityAdminContribution } from '../src/admin';
import { bookingAvailabilityAdminApi, BookingAvailabilityAdminError } from '../src/admin-api';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

const roomTypeId = 'a72f7770-1228-4522-8e8e-b89bb47fc532';
const adminContext = { propertyTimeZone: 'America/Los_Angeles', currency: 'USD',
  roomTypes: [{ id: roomTypeId, name: 'King', maxOccupancyPerUnit: 3 }] };
function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(status >= 400 ? { success: false, error: data } : { success: true, data }), { status });
}

it('contributes a Booking availability route with read and manage permissions', () => {
  expect(bookingAvailabilityAdminContribution.key).toBe('booking-availability');
  expect(bookingAvailabilityAdminContribution.routes.map(route => [route.path, route.module, route.permissions]))
    .toEqual([['availability', 'booking-availability', ['booking-availability:read', 'booking-availability:manage']]]);
});

it('shows Property-local dates, distinct inventory and occupancy, and saves integer minor-unit overrides', async () => {
  const calls: Array<[string, RequestInit]> = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    calls.push([url, options]);
    if (url.endsWith('/availability/context')) return envelope(adminContext);
    if (url.includes('room-night-range') && options.method === 'GET') return envelope({
      roomTypeId, propertyTimeZone: 'America/Los_Angeles', currency: 'USD', baseNightlyPriceMinor: 12000,
      nights: [{ localDate: '2026-10-01', sellableUnits: 5, reservedUnits: 2,
        nightlyPriceOverrideMinor: null, effectiveNightlyPriceMinor: 12000 }],
    });
    return envelope({ updated: 1 });
  });
  render(bookingAvailabilityAdminContribution.routes[0].render(undefined) as React.ReactElement);
  await screen.findByText('King');
  fireEvent.change(screen.getByLabelText('Start local date'), { target: { value: '2026-10-01' } });
  fireEvent.change(screen.getByLabelText('End local date (exclusive)'), { target: { value: '2026-10-02' } });
  fireEvent.click(screen.getByRole('button', { name: 'View availability' }));
  await screen.findByText('2026-10-01');
  expect(screen.getByText(/America\/Los_Angeles/)).toBeTruthy();
  expect(screen.getByText('Maximum occupancy per unit: 3')).toBeTruthy();
  expect(screen.getByText('5')).toBeTruthy();
  expect(screen.getByText('2')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Sellable units'), { target: { value: '6' } });
  fireEvent.change(screen.getByLabelText('Nightly price override (USD minor units)'), { target: { value: '13500' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save range' }));
  await waitFor(() => expect(calls.some(([url, options]) => url.endsWith('/availability/room-night-range') && options.method === 'PUT')).toBe(true));
  const write = calls.find(([url, options]) => url.endsWith('/availability/room-night-range') && options.method === 'PUT')![1];
  expect(JSON.parse(String(write.body))).toEqual({ roomTypeId, startLocalDate: '2026-10-01', endLocalDateExclusive: '2026-10-02', sellableUnits: 6, nightlyPriceOverrideMinor: 13500 });
  expect((write.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
});

it('uses session and CSRF for direct availability actions and hides server detail on safe failures', async () => {
  Object.defineProperty(document, 'cookie', { configurable: true, value: '__Host-commerce_csrf=secure%20token' });
  const fetchMock = vi.fn().mockResolvedValueOnce(envelope({ updated: 1 }))
    .mockResolvedValueOnce(envelope({ code: 'FORBIDDEN', message: 'internal permission detail' }, 403))
    .mockResolvedValueOnce(envelope({ code: 'CONFLICT', message: 'private reservation detail' }, 409));
  globalThis.fetch = fetchMock;
  const input = { roomTypeId, startLocalDate: '2026-10-01', endLocalDateExclusive: '2026-10-02', sellableUnits: 6 };
  await bookingAvailabilityAdminApi.updateRoomNightRange(input, 'stable-key');
  const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('/api/v1/booking/operator/availability/room-night-range');
  expect(options).toMatchObject({ method: 'PUT', credentials: 'same-origin', headers: {
    'X-CSRF-Token': 'secure token', 'Idempotency-Key': 'stable-key', 'Content-Type': 'application/json',
  } });
  expect(options.headers).not.toHaveProperty('Authorization');
  await expect(bookingAvailabilityAdminApi.getRoomNightRange(input)).rejects.toMatchObject({ status: 403,
    message: 'Your session lacks permission to manage availability.' });
  await expect(bookingAvailabilityAdminApi.getRoomNightRange(input)).rejects.toEqual(new BookingAvailabilityAdminError(409,
    'CONFLICT', 'Availability conflicts with reserved units or required property facts.'));
});

it('rejects malformed local dates and fractional prices before sending range actions', async () => {
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    if (url.endsWith('/availability/context')) return envelope(adminContext);
    if (options.method === 'GET') return envelope({ roomTypeId, propertyTimeZone: 'America/Los_Angeles', currency: 'USD', baseNightlyPriceMinor: 12000, nights: [] });
    return envelope({ updated: 1 });
  });
  render(bookingAvailabilityAdminContribution.routes[0].render(undefined) as React.ReactElement);
  await screen.findByText('King');
  fireEvent.change(screen.getByLabelText('Start local date'), { target: { value: '2026-10-02' } });
  fireEvent.change(screen.getByLabelText('End local date (exclusive)'), { target: { value: '2026-10-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'View availability' }));
  await screen.findByRole('alert');
  expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  const endInput = screen.getByLabelText('End local date (exclusive)') as HTMLInputElement;
  fireEvent.change(endInput, { target: { value: endInput.value === '2026-10-03' ? '2026-10-04' : '2026-10-03' } });
  fireEvent.click(screen.getByRole('button', { name: 'View availability' }));
  await screen.findByRole('button', { name: 'Save range' });
  fireEvent.change(screen.getByLabelText('Nightly price override (USD minor units)'), { target: { value: '12.5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save range' }));
  await screen.findByRole('alert');
  expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
});

it('retries an uncertain save with its original body and idempotency key', async () => {
  const writes: RequestInit[] = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    if (url.endsWith('/availability/context')) return envelope(adminContext);
    if (options.method === 'GET') return envelope({ roomTypeId, propertyTimeZone: 'America/Los_Angeles', currency: 'USD', baseNightlyPriceMinor: 12000, nights: [] });
    writes.push(options);
    if (writes.length === 1) throw new Error('lost response');
    return envelope({ updated: 1 });
  });
  render(bookingAvailabilityAdminContribution.routes[0].render(undefined) as React.ReactElement);
  await screen.findByText('King');
  fireEvent.click(screen.getByRole('button', { name: 'View availability' }));
  await screen.findByRole('button', { name: 'Save range' });
  fireEvent.change(screen.getByLabelText('Sellable units'), { target: { value: '4' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save range' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry original range save' }));
  await screen.findByRole('status');
  expect(writes).toHaveLength(2);
  expect(writes[1].body).toBe(writes[0].body);
  expect((writes[1].headers as Record<string, string>)['Idempotency-Key'])
    .toBe((writes[0].headers as Record<string, string>)['Idempotency-Key']);
});

it('ignores a room-night response after the operator changes the local date range', async () => {
  let resolveRange!: (response: Response) => void;
  const pendingRange = new Promise<Response>(resolve => { resolveRange = resolve; });
  globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
    if (url.endsWith('/availability/context')) return envelope(adminContext);
    return pendingRange;
  });
  render(bookingAvailabilityAdminContribution.routes[0].render(undefined) as React.ReactElement);
  await screen.findByText('King');
  fireEvent.click(screen.getByRole('button', { name: 'View availability' }));
  await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2));
  const endInput = screen.getByLabelText('End local date (exclusive)') as HTMLInputElement;
  fireEvent.change(endInput, { target: { value: endInput.value === '2026-10-03' ? '2026-10-04' : '2026-10-03' } });
  await act(async () => resolveRange(envelope({ roomTypeId, propertyTimeZone: 'America/Los_Angeles', currency: 'USD', baseNightlyPriceMinor: 12000,
    nights: [{ localDate: '2026-10-01', sellableUnits: 5, reservedUnits: 2,
      nightlyPriceOverrideMinor: null, effectiveNightlyPriceMinor: 12000 }] })));
  await waitFor(() => expect(screen.queryByText('2026-10-01')).toBeNull());
  expect(screen.queryByRole('button', { name: 'Save range' })).toBeNull();
});
