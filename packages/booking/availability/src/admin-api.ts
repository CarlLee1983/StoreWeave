import type { AvailabilityAdminContext, SetBaseNightlyPriceInput, UpdateRoomNightRangeInput } from './types';

const base = '/api/v1/booking/operator';
export type RoomNightRange = {
  roomTypeId: string;
  propertyTimeZone: string;
  currency: string;
  baseNightlyPriceMinor: number | null;
  nights: { localDate: string; sellableUnits: number; reservedUnits: number;
    nightlyPriceOverrideMinor: number | null; effectiveNightlyPriceMinor: number | null }[];
};

export class BookingAvailabilityAdminError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function csrfToken(cookie: string): string {
  for (const name of ['__Host-commerce_csrf', 'commerce_csrf']) {
    const value = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
    if (value) {
      try { return decodeURIComponent(value.slice(name.length + 1)); } catch { return ''; }
    }
  }
  return '';
}

async function request<T>(path: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = key ?? crypto.randomUUID();
    const token = csrfToken(document.cookie);
    if (token) headers['X-CSRF-Token'] = token;
  }
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { method, headers, credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new BookingAvailabilityAdminError(0, 'NETWORK_ERROR', 'Connection lost. Retry the original save.');
  }
  const envelope: unknown = await response.json().catch(() => null);
  if (typeof envelope !== 'object' || envelope === null || !('success' in envelope)) {
    throw new BookingAvailabilityAdminError(response.status, 'INVALID_RESPONSE', 'The server returned an unreadable response.');
  }
  if (envelope.success !== true) {
    const error = 'error' in envelope && typeof envelope.error === 'object' && envelope.error !== null ? envelope.error : {};
    const code = 'code' in error && typeof error.code === 'string' ? error.code : 'REQUEST_FAILED';
    const message = response.status === 401 || response.status === 403 ? 'Your session lacks permission to manage availability.'
      : response.status === 404 ? 'The room type was not found.'
      : response.status === 409 ? 'Availability conflicts with reserved units or required property facts.'
      : response.status === 400 || response.status === 422 ? 'Check the local dates, units, and minor-unit prices.'
      : 'The request failed. Please try again.';
    throw new BookingAvailabilityAdminError(response.status, code, message);
  }
  if (!response.ok || !('data' in envelope)) throw new BookingAvailabilityAdminError(response.status, 'INVALID_RESPONSE', 'The server returned an unreadable response.');
  return envelope.data as T;
}

export const bookingAvailabilityAdminApi = {
  getAdminContext: () => request<AvailabilityAdminContext | null>('/availability/context'),
  getRoomNightRange: (input: { roomTypeId: string; startLocalDate: string; endLocalDateExclusive: string }) =>
    request<RoomNightRange>(`/availability/room-night-range?${new URLSearchParams(input).toString()}`),
  setBaseNightlyPrice: (input: SetBaseNightlyPriceInput, key: string) =>
    request<{ roomTypeId: string; baseNightlyPriceMinor: number }>('/availability/base-price', 'PUT', input, key),
  updateRoomNightRange: (input: UpdateRoomNightRangeInput, key: string) =>
    request<{ updated: number }>('/availability/room-night-range', 'PUT', input, key),
};
