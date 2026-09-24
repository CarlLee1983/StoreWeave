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

export class BookingReservationAdminError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function csrfToken(cookie: string): string {
  for (const name of ['__Host-commerce_csrf', 'commerce_csrf']) {
    const value = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
    if (value) { try { return decodeURIComponent(value.slice(name.length + 1)); } catch { return ''; } }
  }
  return '';
}

async function request<T>(path: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = key ?? crypto.randomUUID();
    const csrf = csrfToken(document.cookie);
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { method, headers, credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new BookingReservationAdminError(0, 'NETWORK_ERROR', 'Connection lost. Retry the original operation.');
  }
  const envelope: unknown = await response.json().catch(() => null);
  if (typeof envelope !== 'object' || envelope === null || !('success' in envelope)) {
    throw new BookingReservationAdminError(response.status, 'INVALID_RESPONSE', 'The server returned an unreadable response.');
  }
  if (envelope.success !== true) {
    const error = 'error' in envelope && typeof envelope.error === 'object' && envelope.error !== null ? envelope.error : {};
    const code = 'code' in error && typeof error.code === 'string' ? error.code : 'REQUEST_FAILED';
    const message = response.status === 401 || response.status === 403 ? 'Your session lacks permission for this Reservation action.'
      : response.status === 404 ? 'The Reservation or refund was not found.'
      : response.status === 409 ? 'The Reservation or refund state conflicts with this action. Refresh and review it.'
      : response.status === 400 || response.status === 422 ? 'Check the refund amount and audit reason.'
      : 'The request failed. Retry the original operation if its outcome is unknown.';
    throw new BookingReservationAdminError(response.status, code, message);
  }
  if (!response.ok || !('data' in envelope)) throw new BookingReservationAdminError(response.status, 'INVALID_RESPONSE', 'The server returned an unreadable response.');
  return envelope.data as T;
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
