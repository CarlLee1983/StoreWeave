import { ApiError, request as adminRequest } from '../../../../apps/admin/src/api';

/** Browser-only adapter for the Booking operator session endpoints. */
const base = '/api/v1/booking/operator';

export type ReservationListItem = {
  id: string; status: string; roomTypeId: string; checkInLocalDate: string; checkOutLocalDate: string;
  roomCount: number; adults: number; children: number; currency: string; totalMinor: number;
  paymentExpiresAt: string; createdAt: string;
};
export type ReservationDetail = ReservationListItem & {
  winningPaymentAttemptId: string | null;
};
export type PaymentEvidence = {
  id: string; reference: string; providerRef: string | null; provider: string; method: string;
  status: string; successKind: 'winning' | 'late' | 'excess' | null; amountMinor: number; currency: string;
};
export type RefundEvidence = {
  id: string; paymentAttemptId: string; reason: string; status: string; failureKind: string | null;
  amountMinor: number; currency: string; providerRequestRef: string; providerRefundRef: string | null;
};
export type NotificationEvidence = {
  id: string; eventId: string; reference: string; kind: string; mappingStatus: string; mappingFailureCode: string | null;
  deliveries: { id: string; status: string; recipientMasked: string; attempts: number }[];
};
export type Page<T> = { items: T[]; total: number };
export type CancellationInput = { reservationId: string; reason: string; refundAmountMinor: number };

async function request<T>(path: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
  try {
    return await adminRequest<T>(`${base}${path}`, { method, body, idempotent: body !== undefined, idempotencyKey: key, withAuth: false });
  } catch (cause) {
    if (!(cause instanceof ApiError)) throw new ApiError('NETWORK_ERROR', 'Connection lost. Retry the original operation.', 0);
    const message = cause.code === 'IDEMPOTENCY_IN_PROGRESS' || cause.code === 'UNKNOWN_ERROR'
      ? 'The outcome is unknown. Retry the original action.'
      : cause.status === 401 || cause.status === 403 ? 'Your session lacks permission for this Reservation action.'
      : cause.status === 404 ? 'The Reservation or refund was not found.'
      : cause.status === 409 ? 'The Reservation or refund state conflicts with this action. Refresh and review it.'
      : cause.status === 400 || cause.status === 422 ? 'Check the refund amount and audit reason.'
      : 'The request failed. Retry the original operation if its outcome is unknown.';
    throw new ApiError(cause.code, message, cause.status);
  }
}

const page = (offset: number) => `?limit=100&offset=${offset}`;
export const bookingReservationAdminApi = {
  listReservations: (filters: { status?: string; checkInFrom?: string; checkInTo?: string; offset?: number } = {}) =>
    request<Page<ReservationListItem>>(`/reservations?${new URLSearchParams({ limit: '50', offset: String(filters.offset ?? 0),
      ...(filters.status ? { status: filters.status } : {}), ...(filters.checkInFrom ? { checkInFrom: filters.checkInFrom } : {}),
      ...(filters.checkInTo ? { checkInTo: filters.checkInTo } : {}) }).toString()}`),
  getReservation: (id: string) => request<{ reservation: ReservationDetail }>(`/reservations/${encodeURIComponent(id)}`),
  listPaymentAttempts: (id: string, offset = 0) => request<Page<PaymentEvidence>>(`/reservations/${encodeURIComponent(id)}/payment-attempts${page(offset)}`),
  listRefunds: (id: string, offset = 0) => request<Page<RefundEvidence>>(`/reservations/${encodeURIComponent(id)}/refunds${page(offset)}`),
  listNotifications: (id: string, offset = 0) => request<Page<NotificationEvidence>>(`/reservations/${encodeURIComponent(id)}/notifications${page(offset)}`),
  cancel: (input: CancellationInput, key: string) => request<{ reservationId: string; cancelled: true; refund: { id: string; amountMinor: number; currency: string } | null }>('/reservations/cancel', 'POST', input, key),
  retryRefund: (refundId: string, key: string) => request<{ refund: RefundEvidence }>('/refunds/retry', 'POST', { refundId }, key),
};
