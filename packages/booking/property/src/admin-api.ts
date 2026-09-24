import type { PropertyDto, RoomTypeDto } from './types';

export type PropertyInput = Pick<PropertyDto, 'name' | 'address' | 'timezone' | 'currency' | 'checkInTime' | 'checkOutTime' | 'defaultPolicy'>;
export type RoomTypeInput = Pick<RoomTypeDto, 'code' | 'name' | 'description' | 'maxOccupancyPerUnit' | 'beds' | 'amenities' | 'minimumStayNights' | 'maximumStayNights' | 'mediaAssetId'>;
export type RoomTypeUpdate = Omit<RoomTypeInput, 'code'> & Pick<RoomTypeDto, 'status'> & { roomTypeId: string };

const base = '/api/v1/booking/operator';
export class BookingPropertyAdminError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export function csrfToken(cookie: string): string {
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
    response = await fetch(`${base}${path}`, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new BookingPropertyAdminError(0, 'NETWORK_ERROR', 'Connection lost. Retry the same save to avoid a duplicate.');
  }
  const envelope: unknown = await response.json().catch(() => null);
  if (typeof envelope !== 'object' || envelope === null || !('success' in envelope)) {
    throw new BookingPropertyAdminError(response.status, 'INVALID_RESPONSE', 'The server returned an unreadable response.');
  }
  if (envelope.success !== true) {
    const error = 'error' in envelope && typeof envelope.error === 'object' && envelope.error !== null ? envelope.error : {};
    const code = 'code' in error && typeof error.code === 'string' ? error.code : 'REQUEST_FAILED';
    const message = response.status === 401 || response.status === 403 ? 'Your session lacks permission to manage this property.'
      : response.status === 404 ? 'The property or room type was not found.'
      : response.status === 409 ? 'This property or room type conflicts with an existing record.'
      : response.status === 400 || response.status === 422 ? ('message' in error && typeof error.message === 'string' ? error.message : 'Check the entered values.')
      : 'The request failed. Please try again.';
    throw new BookingPropertyAdminError(response.status, code, message);
  }
  if (!response.ok || !('data' in envelope)) throw new BookingPropertyAdminError(response.status, 'INVALID_RESPONSE', 'The server returned an unreadable response.');
  return envelope.data as T;
}

export const bookingPropertyAdminApi = {
  getProperty: async () => (await request<{ property: PropertyDto | null }>('/property')).property,
  listRoomTypes: async () => (await request<{ items: RoomTypeDto[] }>('/room-types')).items,
  createProperty: (input: PropertyInput, key: string) => request<PropertyDto>('/property', 'POST', input, key),
  updateProperty: (input: PropertyInput, key: string) => request<PropertyDto>('/property', 'PUT', input, key),
  createRoomType: (input: RoomTypeInput, key: string) => request<RoomTypeDto>('/room-types', 'POST', input, key),
  updateRoomType: (input: RoomTypeUpdate, key: string) => request<RoomTypeDto>('/room-types', 'PUT', input, key),
};
