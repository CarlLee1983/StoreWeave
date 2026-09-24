// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { bookingPropertyAdminContribution } from '../src/admin';
import { bookingPropertyAdminApi, BookingPropertyAdminError, csrfToken } from '../src/admin-api';

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;

afterEach(() => { cleanup(); globalThis.fetch = originalFetch; Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument }); vi.restoreAllMocks(); });

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(status >= 400 ? { success: false, error: data } : { success: true, data }),
    { status, headers: { 'Content-Type': 'application/json' } });
}

describe('booking-property Admin contribution', () => {
  it('declares both operator permissions and renders real form entries', () => {
    expect(bookingPropertyAdminContribution.key).toBe('booking-property');
    expect(bookingPropertyAdminContribution.routes.map(route => route.path)).toEqual(['property', 'room-types']);
    for (const route of bookingPropertyAdminContribution.routes) {
      expect(route.module).toBe('booking-property');
      expect(route.permissions).toEqual(['booking-property:read', 'booking-property:manage']);
      expect(renderToStaticMarkup(route.render(undefined) as React.ReactElement)).toContain('Loading');
    }
  });

  it('uses the session endpoint, CSRF header, and stable caller-supplied idempotency key without bearer auth', async () => {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: 'commerce_csrf=bare; __Host-commerce_csrf=host%20token' } });
    const fetchMock = vi.fn().mockImplementation(async () => envelope({ id: 'saved' }));
    globalThis.fetch = fetchMock;
    const input = { name: 'House' } as Parameters<typeof bookingPropertyAdminApi.createProperty>[0];
    await bookingPropertyAdminApi.createProperty(input, 'same-uuid-key');
    await bookingPropertyAdminApi.createProperty(input, 'same-uuid-key');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/booking/operator/property');
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('same-origin');
    expect(options.headers).toMatchObject({ 'X-CSRF-Token': 'host token', 'Idempotency-Key': 'same-uuid-key' });
    expect(options.headers).not.toHaveProperty('Authorization');
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].headers).toEqual(options.headers);
  });

  it('reads list data and reports safe permission, conflict, and network errors', async () => {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: '' } });
    globalThis.fetch = vi.fn().mockResolvedValueOnce(envelope({ items: [{ id: 'room' }] }))
      .mockResolvedValueOnce(envelope({ code: 'FORBIDDEN', message: 'internal detail' }, 403))
      .mockResolvedValueOnce(envelope({ code: 'CONFLICT', message: 'internal detail' }, 409))
      .mockRejectedValueOnce(new Error('internal network detail'));
    expect(await bookingPropertyAdminApi.listRoomTypes()).toEqual([{ id: 'room' }]);
    await expect(bookingPropertyAdminApi.getProperty()).rejects.toMatchObject({ status: 403, message: 'Your session lacks permission to manage this property.' });
    await expect(bookingPropertyAdminApi.getProperty()).rejects.toMatchObject({ status: 409, message: 'This property or room type conflicts with an existing record.' });
    await expect(bookingPropertyAdminApi.getProperty()).rejects.toEqual(new BookingPropertyAdminError(0, 'NETWORK_ERROR', 'Connection lost. Retry the same save to avoid a duplicate.'));
  });

  it('selects secure CSRF cookie and tolerates malformed cookie encoding', () => {
    expect(csrfToken('commerce_csrf=bare; __Host-commerce_csrf=secure%20value')).toBe('secure value');
    expect(csrfToken('commerce_csrf=%')).toBe('');
  });
  it('creates the singleton Property through the contributed mounted form', async () => {
    const calls: Array<[string, RequestInit]> = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
      calls.push([url, options]);
      return url.endsWith('/property') && options.method === 'GET'
        ? envelope({ property: null }) : envelope({ id: 'property-1', ...JSON.parse(String(options.body)) });
    });
    render(bookingPropertyAdminContribution.routes[0].render(undefined) as React.ReactElement);
    await screen.findByRole('heading', { name: 'Create Property' });
    const values = {
      'Property name': 'Harbor House', 'Country code': 'TW', 'Administrative area': 'Taipei',
      'Locality': 'Zhongshan', 'Address line 1': '1 Harbor Road', 'IANA time zone': 'Asia/Taipei',
      'Currency code': 'TWD', 'Free cancellation hours before check-in': '48',
    };
    for (const [label, value] of Object.entries(values)) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save Property' }));
    await screen.findByRole('status');
    expect(calls[1][0]).toBe('/api/v1/booking/operator/property');
    expect(calls[1][1].method).toBe('POST');
    expect(JSON.parse(String(calls[1][1].body))).toMatchObject({ name: 'Harbor House', timezone: 'Asia/Taipei',
      currency: 'TWD', address: { countryCode: 'TW', locality: 'Zhongshan' },
      defaultPolicy: { freeCancellationHoursBeforeCheckIn: 48 } });
    expect((calls[1][1].headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  });



  it('updates an existing Property without sending DTO-only fields', async () => {
    const property = { id: '5e59b240-1407-48cb-af7c-c40034ad4f3b', name: 'Original House',
      address: { countryCode: 'TW', postalCode: null, administrativeArea: 'Taipei', locality: 'Zhongshan',
        addressLine1: '1 Harbor Road', addressLine2: null }, timezone: 'Asia/Taipei', currency: 'TWD',
      checkInTime: '15:00', checkOutTime: '11:00', defaultPolicy: { freeCancellationHoursBeforeCheckIn: 24 },
      createdAt: '2026-01-01', updatedAt: '2026-01-02' };
    const calls: Array<[string, RequestInit]> = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
      calls.push([url, options]);
      return options.method === 'GET' ? envelope({ property })
        : envelope({ ...property, ...JSON.parse(String(options.body)) });
    });
    render(bookingPropertyAdminContribution.routes[0].render(undefined) as React.ReactElement);
    await screen.findByRole('heading', { name: 'Edit Property' });
    fireEvent.change(screen.getByLabelText('Property name'), { target: { value: 'Updated House' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save Property' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('saved'));
    expect(calls[1][1].method).toBe('PUT');
    expect(JSON.parse(String(calls[1][1].body))).toEqual({
      name: 'Updated House', address: property.address, timezone: 'Asia/Taipei', currency: 'TWD',
      checkInTime: '15:00', checkOutTime: '11:00', defaultPolicy: { freeCancellationHoursBeforeCheckIn: 24 },
    });
  });

  it('locks an unknown Property save and retries the original body and key until rejection', async () => {
    const writes: RequestInit[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, options: RequestInit) => {
      if (options.method === 'GET') return envelope({ property: null });
      writes.push(options);
      if (writes.length === 1) throw new Error('response lost');
      if (writes.length === 2) return envelope({ code: 'VALIDATION_ERROR', message: 'Check values' }, 400);
      return envelope({ id: 'saved', ...JSON.parse(String(options.body)) });
    });
    render(bookingPropertyAdminContribution.routes[0].render(undefined) as React.ReactElement);
    await screen.findByRole('heading', { name: 'Create Property' });
    for (const [label, value] of Object.entries({
      'Property name': 'Original House', 'Country code': 'TW', 'Administrative area': 'Taipei',
      'Locality': 'Zhongshan', 'Address line 1': '1 Harbor Road', 'IANA time zone': 'Asia/Taipei', 'Currency code': 'TWD',
    })) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save Property' }));
    await screen.findByRole('button', { name: 'Retry original save' });
    expect(screen.getByLabelText('Property name').closest('fieldset')).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('Property name'), { target: { value: 'Changed House' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry original save' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry original save' })).toBeNull());
    expect(writes[1].body).toBe(writes[0].body);
    expect((writes[1].headers as Record<string, string>)['Idempotency-Key']).toBe((writes[0].headers as Record<string, string>)['Idempotency-Key']);
    expect(screen.getByLabelText('Property name').closest('fieldset')).toHaveProperty('disabled', false);
    fireEvent.change(screen.getByLabelText('Property name'), { target: { value: 'Changed House' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save Property' }));
    await screen.findByRole('status');
    expect(JSON.parse(String(writes[2].body)).name).toBe('Changed House');
    expect((writes[2].headers as Record<string, string>)['Idempotency-Key']).not.toBe((writes[0].headers as Record<string, string>)['Idempotency-Key']);
  });

  it('clears an unknown save after the original request succeeds', async () => {
    const writes: RequestInit[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, options: RequestInit) => {
      if (options.method === 'GET') return envelope({ property: null });
      writes.push(options);
      if (writes.length === 1) return envelope({ code: 'SERVER_ERROR' }, 503);
      return envelope({ id: 'saved', ...JSON.parse(String(options.body)) });
    });
    render(bookingPropertyAdminContribution.routes[0].render(undefined) as React.ReactElement);
    await screen.findByRole('heading', { name: 'Create Property' });
    for (const [label, value] of Object.entries({
      'Property name': 'House', 'Country code': 'TW', 'Administrative area': 'Taipei',
      'Locality': 'Zhongshan', 'Address line 1': '1 Harbor Road', 'IANA time zone': 'Asia/Taipei', 'Currency code': 'TWD',
    })) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save Property' }));
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Retry original save' }));
    await screen.findByRole('status');
    expect(screen.queryByRole('button', { name: 'Retry original save' })).toBeNull();
    expect(writes[1].body).toBe(writes[0].body);
    expect((writes[1].headers as Record<string, string>)['Idempotency-Key']).toBe((writes[0].headers as Record<string, string>)['Idempotency-Key']);
    expect(screen.getByLabelText('Property name').closest('fieldset')).toHaveProperty('disabled', false);
  });
  it('creates a Room Type with exactly the command facts and no update-only status', async () => {
    const calls: Array<[string, RequestInit]> = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
      calls.push([url, options]);
      return options.method === 'GET' ? envelope({ items: [] })
        : envelope({ id: 'room-1', status: 'active', ...JSON.parse(String(options.body)) });
    });
    render(bookingPropertyAdminContribution.routes[1].render(undefined) as React.ReactElement);
    await screen.findByRole('heading', { name: 'Create Room Type' });
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'queen-room' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Queen Room' } });
    fireEvent.change(screen.getByLabelText('Maximum occupancy per unit'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Beds'), { target: { value: 'queen,1' } });
    fireEvent.change(screen.getByLabelText('Amenities'), { target: { value: 'wifi,Wi-Fi' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save Room Type' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('saved'));
    expect(calls[1][0]).toBe('/api/v1/booking/operator/room-types');
    expect(calls[1][1].method).toBe('POST');
    expect(JSON.parse(String(calls[1][1].body))).toEqual({
      code: 'queen-room', name: 'Queen Room', description: null, maxOccupancyPerUnit: 3,
      beds: [{ type: 'queen', count: 1 }], amenities: [{ code: 'wifi', label: 'Wi-Fi' }],
      minimumStayNights: 1, maximumStayNights: null, mediaAssetId: null,
    });
  });
  it('updates an existing Room Type without sending immutable code and displays a forbidden error', async () => {
    const room = { id: 'a72f7770-1228-4522-8e8e-b89bb47fc532', code: 'queen-room', name: 'Queen Room',
      description: null, maxOccupancyPerUnit: 2, beds: [{ type: 'queen', count: 1 }],
      amenities: [{ code: 'wifi', label: 'Wi-Fi' }], minimumStayNights: 1, maximumStayNights: null,
      mediaAssetId: null, status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    const calls: Array<[string, RequestInit]> = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
      calls.push([url, options]);
      return options.method === 'GET' ? envelope({ items: [room] })
        : envelope({ code: 'FORBIDDEN', message: 'sensitive detail' }, 403);
    });
    render(bookingPropertyAdminContribution.routes[1].render(undefined) as React.ReactElement);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Queen Room (queen-room)' }));
    expect(screen.getByLabelText('Code')).toHaveProperty('readOnly', true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated Queen Room' } });
    fireEvent.change(screen.getByLabelText('Maximum occupancy per unit'), { target: { value: '3' } });
    await userEvent.setup().selectOptions(screen.getByLabelText('Status'), 'disabled');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save Room Type' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('lacks permission'));
    expect(screen.getByRole('alert').textContent).not.toContain('sensitive detail');
    expect(calls[1][0]).toBe('/api/v1/booking/operator/room-types');
    expect(calls[1][1].method).toBe('PUT');
    const body = JSON.parse(String(calls[1][1].body));
    expect(body).toMatchObject({ roomTypeId: room.id, name: 'Updated Queen Room', maxOccupancyPerUnit: 3, status: 'disabled',
      beds: [{ type: 'queen', count: 1 }], amenities: [{ code: 'wifi', label: 'Wi-Fi' }] });
    expect(body).not.toHaveProperty('code');
  });

});
