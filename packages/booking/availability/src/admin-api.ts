import { ApiError, request as adminRequest } from '../../../../apps/admin/src/api';
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

async function request<T>(path: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
  try {
    return await adminRequest<T>(`${base}${path}`, { method, body, idempotent: body !== undefined, idempotencyKey: key, withAuth: false });
  } catch (cause) {
    if (!(cause instanceof ApiError)) throw new ApiError('NETWORK_ERROR', 'Connection lost. Retry the original save.', 0);
    const message = cause.code === 'IDEMPOTENCY_IN_PROGRESS' || cause.code === 'UNKNOWN_ERROR'
      ? 'The outcome is unknown. Retry the original action.'
      : cause.status === 401 || cause.status === 403 ? 'Your session lacks permission to manage availability.'
      : cause.status === 404 ? 'The room type was not found.'
      : cause.status === 409 ? 'Availability conflicts with reserved units or required property facts.'
      : cause.status === 400 || cause.status === 422 ? 'Check the local dates, units, and minor-unit prices.'
      : 'The request failed. Please try again.';
    throw new ApiError(cause.code, message, cause.status);
  }
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
