import { ApiError, request as adminRequest } from '../../../../apps/admin/src/api';
import type { PropertyDto, RoomTypeDto } from './types';

export type PropertyInput = Pick<PropertyDto, 'name' | 'address' | 'timezone' | 'currency' | 'checkInTime' | 'checkOutTime' | 'defaultPolicy'>;
export type RoomTypeInput = Pick<RoomTypeDto, 'code' | 'name' | 'description' | 'maxOccupancyPerUnit' | 'beds' | 'amenities' | 'minimumStayNights' | 'maximumStayNights' | 'mediaAssetId'>;
export type RoomTypeUpdate = Omit<RoomTypeInput, 'code'> & Pick<RoomTypeDto, 'status'> & { roomTypeId: string };

const base = '/api/v1/booking/operator';
async function request<T>(path: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
  try {
    return await adminRequest<T>(`${base}${path}`, { method, body, idempotent: body !== undefined, idempotencyKey: key, withAuth: false });
  } catch (cause) {
    if (!(cause instanceof ApiError)) throw new ApiError('NETWORK_ERROR', 'Connection lost. Retry the same save to avoid a duplicate.', 0);
    const message = cause.code === 'IDEMPOTENCY_IN_PROGRESS' || cause.code === 'UNKNOWN_ERROR'
      ? 'The outcome is unknown. Retry the original action.'
      : cause.status === 401 || cause.status === 403 ? 'Your session lacks permission to manage this property.'
      : cause.status === 404 ? 'The property or room type was not found.'
      : cause.status === 409 ? 'This property or room type conflicts with an existing record.'
      : cause.status === 400 || cause.status === 422 ? cause.message
      : 'The request failed. Please try again.';
    throw new ApiError(cause.code, message, cause.status);
  }
}

export const bookingPropertyAdminApi = {
  getProperty: async () => (await request<{ property: PropertyDto | null }>('/property')).property,
  listRoomTypes: async () => (await request<{ items: RoomTypeDto[] }>('/room-types')).items,
  createProperty: (input: PropertyInput, key: string) => request<PropertyDto>('/property', 'POST', input, key),
  updateProperty: (input: PropertyInput, key: string) => request<PropertyDto>('/property', 'PUT', input, key),
  createRoomType: (input: RoomTypeInput, key: string) => request<RoomTypeDto>('/room-types', 'POST', input, key),
  updateRoomType: (input: RoomTypeUpdate, key: string) => request<RoomTypeDto>('/room-types', 'PUT', input, key),
};
