// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { bookingReservationAdminContribution } from '../src/admin';
import { bookingReservationAdminApi } from '../src/admin-api';

const reservationId = 'a72f7770-1228-4522-8e8e-b89bb47fc532';
const attemptId = 'b72f7770-1228-4522-8e8e-b89bb47fc532';
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; vi.restoreAllMocks(); });
const envelope = (data: unknown, status = 200) => new Response(JSON.stringify(status >= 400 ? { success: false, error: data } : { success: true, data }), { status });
const listItem = { id: reservationId, status: 'confirmed', roomTypeId: 'room', checkInLocalDate: '2026-10-01', checkOutLocalDate: '2026-10-03', roomCount: 1, adults: 2, children: 0, currency: 'TWD', totalMinor: 5000, paymentExpiresAt: '2026-09-30T00:00:00Z', createdAt: '2026-09-01T00:00:00Z' };
const detail = { ...listItem, booker: { name: 'Private Booker', email: 'secret@example.com', phone: '0912345678' }, primaryGuestName: 'Private Guest', accommodationNotes: 'Private medical note', winningPaymentAttemptId: attemptId, nights: [], cancellationPolicy: {} };
const attempts = [{ id: attemptId, reservationId, reference: 'pay-win', providerRef: 'provider-win', status: 'succeeded', successKind: 'winning', amountMinor: 5000, currency: 'TWD' }, { id: 'late-id', reservationId, reference: 'pay-late', providerRef: 'provider-late', status: 'succeeded', successKind: 'late', amountMinor: 6000, currency: 'TWD' }];
function fixtures(url: string, options: RequestInit): Response {
  if (url.includes('/reservations?') && options.method === 'GET') return envelope({ items: [listItem], total: 1 });
  if (url.endsWith(`/reservations/${reservationId}`)) return envelope({ reservation: detail });
  if (url.includes('payment-attempts')) return envelope({ items: attempts, total: 2 });
  if (url.includes('/refunds') && options.method === 'GET') return envelope({ items: [{ id: 'refund-id', paymentAttemptId: 'late-id', reason: 'late_payment', status: 'failed', failureKind: 'rejected', amountMinor: 6000, currency: 'TWD', providerRequestRef: 'refund-ref' }], total: 1 });
  if (url.includes('/notifications')) return envelope({ items: [{ id: 'link-id', eventId: 'event-id', reference: 'notice-ref', kind: 'confirmed', mappingStatus: 'mapping_failed', mappingFailureCode: 'booker_unavailable', deliveries: [{ id: 'delivery-id', status: 'failed', recipientMasked: 's***@example.com' }] }], total: 1 });
  return envelope({ reservationId, cancelled: true, refund: { id: 'new-refund', amountMinor: 5000, currency: 'TWD' } });
}

it('declares the Reservation route and shows correlated evidence without unnecessary PII', async () => {
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => fixtures(url, options));
  expect(bookingReservationAdminContribution.routes.map(route => [route.path, route.module, route.permissions])).toEqual([
    ['reservations', 'booking-reservation', ['booking-reservation:operator-read']],
  ]);
  render(bookingReservationAdminContribution.routes[0].render(undefined) as React.ReactElement);
  fireEvent.click(await screen.findByRole('button', { name: /2026-10-01/ }));
  await screen.findByText(/pay-late/);
  expect(screen.getByText(/refund-ref/)).toBeTruthy();
  expect(screen.getByText(/notice-ref/)).toBeTruthy();
  expect(screen.getByText(/event-id/)).toBeTruthy();
  expect(screen.getByText(/s\*\*\*@example.com/)).toBeTruthy();
  expect(document.body.textContent).not.toContain('secret@example.com');
  expect(document.body.textContent).not.toContain('Private medical note');
});

it('validates the whole-Reservation decision against winning received money and retries an uncertain original request', async () => {
  const writes: RequestInit[] = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    if (url.endsWith('/reservations/cancel')) { writes.push(options); if (writes.length === 1) throw new Error('lost response'); }
    return fixtures(url, options);
  });
  render(bookingReservationAdminContribution.routes[0].render(undefined) as React.ReactElement);
  fireEvent.click(await screen.findByRole('button', { name: /2026-10-01/ }));
  await screen.findByText(/pay-win/);
  fireEvent.change(screen.getByLabelText('Refund amount (TWD minor units)'), { target: { value: '6000' } });
  fireEvent.change(screen.getByLabelText('Audit reason'), { target: { value: 'Operator decision' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Cancel Reservation' }).closest('form')!);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('5000'));
  expect(writes).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('Refund amount (TWD minor units)'), { target: { value: '5000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel Reservation' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry original cancellation' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1].body).toBe(writes[0].body);
  expect((writes[1].headers as Record<string, string>)['Idempotency-Key']).toBe((writes[0].headers as Record<string, string>)['Idempotency-Key']);
  expect(JSON.parse(String(writes[0].body))).toEqual({ reservationId, reason: 'Operator decision', refundAmountMinor: 5000 });
});

it('maps backend failures to distinct safe feedback and sends session, CSRF, and idempotency headers', async () => {
  Object.defineProperty(document, 'cookie', { configurable: true, value: '__Host-commerce_csrf=secure%20token' });
  const fetchMock = vi.fn().mockResolvedValueOnce(envelope({ code: 'FORBIDDEN', message: 'secret' }, 403))
    .mockResolvedValueOnce(envelope({ code: 'NOT_FOUND', message: 'secret' }, 404))
    .mockResolvedValueOnce(envelope({ code: 'CONFLICT', message: 'secret' }, 409));
  globalThis.fetch = fetchMock;
  await expect(bookingReservationAdminApi.listReservations()).rejects.toThrow(/permission/i);
  await expect(bookingReservationAdminApi.getReservation(reservationId)).rejects.toThrow(/not found/i);
  await expect(bookingReservationAdminApi.cancel({ reservationId, reason: 'reason', refundAmountMinor: 0 }, 'fixed-key')).rejects.toThrow(/conflict/i);
  const [, options] = fetchMock.mock.calls[2] as [string, RequestInit];
  expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': 'secure token', 'Idempotency-Key': 'fixed-key' } });
  expect(options.headers).not.toHaveProperty('Authorization');
});

it('allows a pending-payment Reservation to be cancelled only with zero refund', async () => {
  const writes: RequestInit[] = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    if (url.endsWith(`/reservations/${reservationId}`)) return envelope({ reservation: { ...detail, status: 'pending_payment', winningPaymentAttemptId: null } });
    if (url.includes('payment-attempts')) return envelope({ items: [], total: 0 });
    if (url.endsWith('/reservations/cancel')) writes.push(options);
    return fixtures(url, options);
  });
  render(bookingReservationAdminContribution.routes[0].render(undefined) as React.ReactElement);
  fireEvent.click(await screen.findByRole('button', { name: /2026-10-01/ }));
  await screen.findByText(/No payment received/);
  fireEvent.change(screen.getByLabelText('Refund amount (TWD minor units)'), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText('Audit reason'), { target: { value: 'No payment' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel Reservation' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(JSON.parse(String(writes[0].body))).toEqual({ reservationId, reason: 'No payment', refundAmountMinor: 0 });
});

it('retries a failed refund using the original refund ID and idempotency key after an unknown result', async () => {
  const writes: RequestInit[] = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    if (url.endsWith('/refunds/retry')) { writes.push(options); if (writes.length === 1) throw new Error('response lost'); }
    return fixtures(url, options);
  });
  render(bookingReservationAdminContribution.routes[0].render(undefined) as React.ReactElement);
  fireEvent.click(await screen.findByRole('button', { name: /2026-10-01/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry failed refund' }));
  expect((await screen.findByRole('button', { name: 'Retry original refund action' })).hasAttribute('disabled')).toBe(false);
  expect(screen.getByRole('button', { name: 'Retry failed refund' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry original refund action' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1].body).toBe(writes[0].body);
  expect((writes[1].headers as Record<string, string>)['Idempotency-Key']).toBe((writes[0].headers as Record<string, string>)['Idempotency-Key']);
  expect(JSON.parse(String(writes[0].body))).toEqual({ refundId: 'refund-id' });
});

it('finds an older winning payment and lets the operator load older failure evidence', async () => {
  const older = Array.from({ length: 100 }, (_, index) => ({ ...attempts[1], id: `attempt-${index}`, reference: `newer-${index}` }));
  const calls: string[] = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    calls.push(url);
    if (url.includes('payment-attempts')) return envelope({ items: url.includes('offset=100') ? [attempts[0]] : older, total: 101 });
    if (url.includes('/refunds') && options.method === 'GET') return envelope({ items: url.includes('offset=1') ? [{ id: 'old-refund', paymentAttemptId: attemptId, reason: 'reservation_cancellation', status: 'failed', failureKind: 'indeterminate', amountMinor: 5000, currency: 'TWD', providerRequestRef: 'older-refund-ref' }] : [{ id: 'new-refund', paymentAttemptId: 'late-id', reason: 'late_payment', status: 'succeeded', failureKind: null, amountMinor: 6000, currency: 'TWD', providerRequestRef: 'new-refund-ref' }], total: 2 });
    return fixtures(url, options);
  });
  render(bookingReservationAdminContribution.routes[0].render(undefined) as React.ReactElement);
  fireEvent.click(await screen.findByRole('button', { name: /2026-10-01/ }));
  await screen.findByText(/pay-win/);
  expect(calls.some(url => url.includes('payment-attempts?limit=100&offset=100'))).toBe(true);
  expect(screen.getByRole('button', { name: 'Cancel Reservation' }).hasAttribute('disabled')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /Load older refund evidence/ }));
  await screen.findByText(/older-refund-ref/);
  expect(calls.some(url => url.includes('refunds?limit=100&offset=1'))).toBe(true);
});

it('keeps the newest Reservation search result when an earlier request completes later', async () => {
  let resolveFirst!: (response: Response) => void;
  const first = new Promise<Response>(resolve => { resolveFirst = resolve; });
  const fetchMock = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    if (url.includes('/reservations?') && fetchMock.mock.calls.length === 1) return first;
    return url.includes('/reservations?') ? envelope({ items: [{ ...listItem, id: 'newer-id' }], total: 1 }) : fixtures(url, options);
  });
  globalThis.fetch = fetchMock;
  render(bookingReservationAdminContribution.routes[0].render(undefined) as React.ReactElement);
  fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'confirmed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search Reservations' }));
  await screen.findByRole('button', { name: /newer-id/ });
  resolveFirst(envelope({ items: [listItem], total: 1 }));
  await waitFor(() => expect(screen.queryByRole('button', { name: new RegExp(reservationId) })).toBeNull());
});

it('rejects a missing audit reason and shows safe forbidden and unavailable-action feedback', async () => {
  const writes: string[] = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    if (options.method === 'POST') {
      writes.push(url);
      return envelope({ code: 'FORBIDDEN', message: 'private rule' }, url.endsWith('/reservations/cancel') ? 403 : 409);
    }
    return fixtures(url, options);
  });
  render(bookingReservationAdminContribution.routes[0].render(undefined) as React.ReactElement);
  fireEvent.click(await screen.findByRole('button', { name: /2026-10-01/ }));
  await screen.findByText(/pay-win/);
  fireEvent.change(screen.getByLabelText('Refund amount (TWD minor units)'), { target: { value: '0' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Cancel Reservation' }).closest('form')!);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Audit reason'));
  expect(writes).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('Audit reason'), { target: { value: 'Operator decision' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel Reservation' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('lacks permission'));
  expect(screen.getByRole('alert').textContent).not.toContain('private rule');
  fireEvent.click(screen.getByRole('button', { name: 'Retry failed refund' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('conflicts'));
  expect(screen.getByRole('alert').textContent).not.toContain('private rule');
});

it('discards a failed older-payment lookup after selecting a different Reservation', async () => {
  const otherId = 'c72f7770-1228-4522-8e8e-b89bb47fc532';
  let rejectOlder!: (reason: Error) => void;
  const older = new Promise<Response>((_, reject) => { rejectOlder = reject; });
  const newerAttempts = Array.from({ length: 100 }, (_, index) => ({ ...attempts[1], id: `new-${index}` }));
  const calls: string[] = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    calls.push(url);
    if (url.includes('/reservations?')) return envelope({ items: [listItem, { ...listItem, id: otherId }], total: 2 });
    if (url.endsWith(`/reservations/${otherId}`)) return envelope({ reservation: { ...detail, id: otherId } });
    if (url.includes(`/reservations/${otherId}/payment-attempts`)) return envelope({ items: [attempts[0]], total: 1 });
    if (url.includes(`/reservations/${reservationId}/payment-attempts`)) return url.includes('offset=100') ? older : envelope({ items: newerAttempts, total: 101 });
    return fixtures(url, options);
  });
  render(bookingReservationAdminContribution.routes[0].render(undefined) as React.ReactElement);
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(reservationId) }));
  await waitFor(() => expect(calls.some(url => url.includes(`${reservationId}/payment-attempts?limit=100&offset=100`))).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: new RegExp(otherId) }));
  await screen.findByRole('heading', { name: `Reservation ${otherId}` });
  rejectOlder(new Error('old lookup failed'));
  await screen.findByText(/pay-win/);
  expect(screen.queryByText(/old lookup failed/)).toBeNull();
});

it('unlocks evidence paging for a new Reservation when the previous load-more request settles', async () => {
  const otherId = 'c72f7770-1228-4522-8e8e-b89bb47fc532';
  let resolveOlder!: (response: Response) => void;
  const older = new Promise<Response>(resolve => { resolveOlder = resolve; });
  const calls: string[] = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    calls.push(url);
    if (url.includes('/reservations?')) return envelope({ items: [listItem, { ...listItem, id: otherId }], total: 2 });
    if (url.endsWith(`/reservations/${otherId}`)) return envelope({ reservation: { ...detail, id: otherId } });
    if (url.includes('/refunds') && options.method === 'GET') return url.includes(`${reservationId}/refunds?limit=100&offset=1`)
      ? older : envelope({ items: [{ id: 'first', paymentAttemptId: attemptId, reason: 'late_payment', status: 'failed', failureKind: 'rejected', amountMinor: 5000, currency: 'TWD', providerRequestRef: 'first-ref' }], total: 2 });
    return fixtures(url, options);
  });
  render(bookingReservationAdminContribution.routes[0].render(undefined) as React.ReactElement);
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(reservationId) }));
  fireEvent.click(await screen.findByRole('button', { name: /Load older refund evidence/ }));
  await waitFor(() => expect(calls.some(url => url.includes(`${reservationId}/refunds?limit=100&offset=1`))).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: new RegExp(otherId) }));
  await screen.findByRole('heading', { name: `Reservation ${otherId}` });
  const next = await screen.findByRole('button', { name: /Load older refund evidence/ });
  expect(next.hasAttribute('disabled')).toBe(false);
  resolveOlder(envelope({ items: [{ id: 'old-a' }], total: 2 }));
  await waitFor(() => expect(screen.queryByText(/old-a/)).toBeNull());
});
