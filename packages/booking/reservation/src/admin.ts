import React, { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { AdminContribution, AdminRouteDefinition } from '@storeweave/release/admin';
import { bookingReservationAdminApi,
  type CancellationInput, type NotificationEvidence, type PaymentEvidence, type RefundEvidence,
  type ReservationDetail, type ReservationListItem } from './admin-api';
import { executeAdminOperation, useAdminOperationEntries, useAdminOperations, type AdminOperation, type AdminOperationEntry } from '../../../../apps/admin/src/admin-operations';

const h = React.createElement;
const displayError = (cause: unknown) => cause instanceof Error ? cause.message : 'The request failed.';
const money = (amount: number, currency: string) => `${amount} ${currency} minor units`;
type ReservationOperation = AdminOperation & (
  | { area: 'booking-reservation'; kind: 'cancel'; request: CancellationInput }
  | { area: 'booking-reservation'; kind: 'retry-refund'; refundId: string }
);
type ReservationOperationEntry = AdminOperationEntry<ReservationOperation>;
function isReservationOperation(entry: AdminOperationEntry): entry is ReservationOperationEntry {
  return entry.operation.area === 'booking-reservation'
    && ['cancel', 'retry-refund'].includes((entry.operation as ReservationOperation).kind);
}
async function runReservationOperation(operation: ReservationOperation) {
  return operation.kind === 'cancel'
    ? bookingReservationAdminApi.cancel(operation.request, operation.idempotencyKey)
    : bookingReservationAdminApi.retryRefund(operation.refundId, operation.idempotencyKey);
}

export function ReservationAdminPage(): ReactNode {
  const [items, setItems] = useState<ReservationListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState('');
  const [checkInFrom, setCheckInFrom] = useState('');
  const [checkInTo, setCheckInTo] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReservationDetail | null>(null);
  const [payments, setPayments] = useState<PaymentEvidence[]>([]);
  const [refunds, setRefunds] = useState<RefundEvidence[]>([]);
  const [notifications, setNotifications] = useState<NotificationEvidence[]>([]);
  const [paymentTotal, setPaymentTotal] = useState(0);
  const [refundTotal, setRefundTotal] = useState(0);
  const [notificationTotal, setNotificationTotal] = useState(0);
  const [evidenceBusy, setEvidenceBusy] = useState('');
  const [evidenceErrors, setEvidenceErrors] = useState<string[]>([]);
  const [refundAmount, setRefundAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const operations = useAdminOperations();
  const recoveries = useAdminOperationEntries().filter(isReservationOperation);
  const unknownCancel = recoveries.some(entry => entry.operation.kind === 'cancel' && entry.phase === 'unknown');
  const unknownRetry = recoveries.some(entry => entry.operation.kind === 'retry-refund' && entry.phase === 'unknown');
  const selection = useRef(0);
  const listRequest = useRef(0);

  const loadList = async (nextOffset = offset) => {
    const request = ++listRequest.current;
    setError('');
    try {
      const result = await bookingReservationAdminApi.listReservations({
        offset: nextOffset, ...(status ? { status } : {}), ...(checkInFrom ? { checkInFrom } : {}),
        ...(checkInTo ? { checkInTo } : {}),
      });
      if (request === listRequest.current) { setItems(result.items); setTotal(result.total); setOffset(nextOffset); }
    } catch (cause) { if (request === listRequest.current) setError(displayError(cause)); }
    finally { if (request === listRequest.current) setLoading(false); }
  };
  useEffect(() => { void loadList(0); }, []);

  const select = async (id: string, preserveFeedback = false) => {
    if ((unknownCancel || unknownRetry) && !preserveFeedback) return;
    const request = ++selection.current;
    setSelectedId(id); setDetail(null); setPayments([]); setRefunds([]); setNotifications([]);
    setPaymentTotal(0); setRefundTotal(0); setNotificationTotal(0); setEvidenceBusy('');
    setEvidenceErrors([]); setError(''); if (!preserveFeedback) setNotice(''); setRefundAmount(''); setReason('');
    try {
      const result = await bookingReservationAdminApi.getReservation(id);
      if (request !== selection.current) return;
      setDetail(result.reservation);
      const evidence = await Promise.allSettled([
        bookingReservationAdminApi.listPaymentAttempts(id), bookingReservationAdminApi.listRefunds(id),
        bookingReservationAdminApi.listNotifications(id),
      ]);
      if (request !== selection.current) return;
      const errors = evidence.flatMap((entry, index) => entry.status === 'rejected'
        ? [`${['Payment', 'Refund', 'Notification'][index]} evidence: ${displayError(entry.reason)}`] : []);
      if (evidence[0].status === 'fulfilled') {
        const first = evidence[0].value;
        const all = [...first.items];
        // The winning attempt can be older than the newest page. Find it before offering cancellation.
        try {
          while (result.reservation.winningPaymentAttemptId && !all.some(item => item.id === result.reservation.winningPaymentAttemptId)
            && all.length < first.total && all.length <= 10_000) {
            const next = await bookingReservationAdminApi.listPaymentAttempts(id, all.length);
            if (request !== selection.current) return;
            if (next.items.length === 0) break;
            all.push(...next.items);
          }
        } catch (cause) {
          errors.push(`Payment evidence: ${displayError(cause)}`);
        }
        if (request !== selection.current) return;
        setPayments(all); setPaymentTotal(first.total);
      }
      if (evidence[1].status === 'fulfilled') { setRefunds(evidence[1].value.items); setRefundTotal(evidence[1].value.total); }
      if (evidence[2].status === 'fulfilled') { setNotifications(evidence[2].value.items); setNotificationTotal(evidence[2].value.total); }
      setEvidenceErrors(errors);
    } catch (cause) { if (request === selection.current) setError(displayError(cause)); }
  };
  const loadMore = async (kind: 'payment' | 'refund' | 'notification') => {
    if (!detail) return;
    const request = selection.current;
    const offset = kind === 'payment' ? payments.length : kind === 'refund' ? refunds.length : notifications.length;
    setEvidenceBusy(kind);
    try {
      if (kind === 'payment') {
        const page = await bookingReservationAdminApi.listPaymentAttempts(detail.id, offset);
        if (request === selection.current) { setPayments(items => [...items, ...page.items]); setPaymentTotal(page.total); }
      } else if (kind === 'refund') {
        const page = await bookingReservationAdminApi.listRefunds(detail.id, offset);
        if (request === selection.current) { setRefunds(items => [...items, ...page.items]); setRefundTotal(page.total); }
      } else {
        const page = await bookingReservationAdminApi.listNotifications(detail.id, offset);
        if (request === selection.current) { setNotifications(items => [...items, ...page.items]); setNotificationTotal(page.total); }
      }
    } catch (cause) { if (request === selection.current) setEvidenceErrors(values => [...values, `${kind} evidence: ${displayError(cause)}`]); }
    finally { if (request === selection.current) setEvidenceBusy(''); }
  };

  const winner = payments.find(payment => payment.id === detail?.winningPaymentAttemptId && payment.successKind === 'winning' && payment.status === 'succeeded');
  const received = winner?.amountMinor ?? 0;
  const saveCancel = async (event?: FormEvent, retryEntry?: ReservationOperationEntry) => {
    event?.preventDefault(); setError(''); setNotice('');
    try {
      let operation: ReservationOperation;
      if (retryEntry) operation = retryEntry.operation;
      else {
        if (!detail || (detail.status === 'confirmed' && !winner)) throw new Error('Winning payment evidence is unavailable. Cancellation is unavailable.');
        const amount = Number(refundAmount);
        if (!/^\d+$/.test(refundAmount) || !Number.isSafeInteger(amount) || amount > received) {
          throw new Error(`Refund amount must be a whole number from 0 through ${received}.`);
        }
        const auditReason = reason.trim();
        if (!auditReason || auditReason.length > 1000) throw new Error('Audit reason must contain 1–1000 characters.');
        operation = { area: 'booking-reservation', scope: `booking.reservation.${detail.id}`, kind: 'cancel',
          idempotencyKey: crypto.randomUUID(), request: { reservationId: detail.id, refundAmountMinor: amount, reason: auditReason } };
      }
      setBusy(true);
      const outcome = await executeAdminOperation(operations, operation, runReservationOperation, (result, live) => {
        if (live.kind !== 'cancel' || !('reservationId' in result)) return;
        setNotice(result.refund ? `Reservation cancelled. Refund ${result.refund.id} is pending independent processing.` : 'Reservation cancelled with no refund.');
        void loadList(); void select(live.request.reservationId, true);
      }, retryEntry);
      if (outcome.state === 'unknown' || outcome.state === 'rejected') setError(displayError(outcome.error));
    } catch (cause) { setError(displayError(cause)); } finally { setBusy(false); }
  };
  const retryRefund = async (refundId: string, retryEntry?: ReservationOperationEntry) => {
    setError(''); setNotice('');
    const operation: ReservationOperation = retryEntry?.operation ?? {
      area: 'booking-reservation', scope: `booking.refund.${refundId}`, kind: 'retry-refund',
      idempotencyKey: crypto.randomUUID(), refundId,
    };
    setBusy(true);
    const outcome = await executeAdminOperation(operations, operation, runReservationOperation, (_result, live) => {
      setNotice('Refund retry queued. Review its outcome in the evidence below.');
      if (detail) void select(detail.id, true);
      else if (live.kind === 'retry-refund') void loadList();
    }, retryEntry);
    if (outcome.state === 'unknown' || outcome.state === 'rejected') setError(displayError(outcome.error));
    setBusy(false);
  };

  return h('section', null,
    h('h2', null, 'Reservations'),
    error && h('p', { role: 'alert' }, error), notice && h('p', { role: 'status' }, notice),
    ...recoveries.filter(entry => entry.phase === 'unknown').map(entry => h('button', { key: entry.operation.scope, type: 'button', disabled: busy,
      onClick: () => entry.operation.kind === 'cancel' ? void saveCancel(undefined, entry) : void retryRefund(entry.operation.refundId, entry) },
    entry.operation.kind === 'cancel' ? 'Retry original cancellation' : 'Retry original refund action')),
    h('form', { onSubmit: (event: FormEvent) => { event.preventDefault(); if (!unknownCancel && !unknownRetry) void loadList(0); } },
      h('label', null, 'Status', h('select', { 'aria-label': 'Status', value: status, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setStatus(event.target.value) },
        ...['', 'pending_payment', 'confirmed', 'expired', 'cancelled'].map(value => h('option', { key: value, value }, value || 'All')))),
      h('label', null, 'Check-in from', h('input', { 'aria-label': 'Check-in from', type: 'date', value: checkInFrom, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setCheckInFrom(event.target.value) })),
      h('label', null, 'Check-in to', h('input', { 'aria-label': 'Check-in to', type: 'date', value: checkInTo, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setCheckInTo(event.target.value) })),
      h('button', { type: 'submit', disabled: unknownCancel || unknownRetry }, 'Search Reservations')),
    loading ? h('p', null, 'Loading Reservations…') : h('p', null, `${total} Reservations`),
    h('ul', null, ...items.map(item => h('li', { key: item.id }, h('button', { type: 'button', disabled: unknownCancel || unknownRetry, onClick: () => void select(item.id) },
      `${item.checkInLocalDate} – ${item.checkOutLocalDate} · ${item.status} · ${item.id}`), ` · ${money(item.totalMinor, item.currency)}`))),
    total > 50 && h('nav', null,
      h('button', { type: 'button', disabled: offset === 0 || unknownCancel || unknownRetry, onClick: () => void loadList(Math.max(0, offset - 50)) }, 'Previous'),
      h('button', { type: 'button', disabled: offset + 50 >= total || unknownCancel || unknownRetry, onClick: () => void loadList(offset + 50) }, 'Next')),
    selectedId && !detail && h('p', null, 'Loading Reservation detail…'),
    detail && h('section', null,
      h('h3', null, `Reservation ${detail.id}`),
      h('p', null, `Status: ${detail.status}; stay: ${detail.checkInLocalDate} to ${detail.checkOutLocalDate}; ${detail.roomCount} room(s); ${money(detail.totalMinor, detail.currency)}`),
      h('h4', null, 'Payment attempts'),
      payments.length === 0 ? h('p', null, 'No payment evidence.') : h('ul', null, ...payments.map(payment => h('li', { key: payment.id },
        `${payment.reference} · ${payment.successKind ?? payment.status} · ${money(payment.amountMinor, payment.currency)} · provider ref ${payment.providerRef ?? '—'}`))),
      payments.length < paymentTotal && h('button', { type: 'button', disabled: !!evidenceBusy || payments.length > 10_000,
        onClick: () => void loadMore('payment') }, `Load older payment evidence (${payments.length}/${paymentTotal})`),
      h('h4', null, 'Refunds'),
      refunds.length === 0 ? h('p', null, 'No refund evidence.') : h('ul', null, ...refunds.map(refund => h('li', { key: refund.id },
        `${refund.providerRequestRef} · payment ${refund.paymentAttemptId} · ${refund.reason} · ${refund.status} · ${money(refund.amountMinor, refund.currency)} · failure ${refund.failureKind ?? '—'}`,
        refund.status === 'failed' && h('button', { type: 'button', disabled: busy || unknownCancel || unknownRetry,
          onClick: () => void retryRefund(refund.id) }, 'Retry failed refund')))),
      refunds.length < refundTotal && h('button', { type: 'button', disabled: !!evidenceBusy || refunds.length > 10_000,
        onClick: () => void loadMore('refund') }, `Load older refund evidence (${refunds.length}/${refundTotal})`),
      h('h4', null, 'Notifications'),
      notifications.length === 0 ? h('p', null, 'No notification evidence.') : h('ul', null, ...notifications.map(notification => h('li', { key: notification.id },
        `${notification.reference} · event ${notification.eventId} · ${notification.kind} · ${notification.mappingStatus} · failure ${notification.mappingFailureCode ?? '—'}`,
        h('ul', null, ...notification.deliveries.map(delivery => h('li', { key: delivery.id },
          `${delivery.status} · ${delivery.recipientMasked}`)))))),
      notifications.length < notificationTotal && h('button', { type: 'button', disabled: !!evidenceBusy || notifications.length > 10_000,
        onClick: () => void loadMore('notification') }, `Load older notification evidence (${notifications.length}/${notificationTotal})`),
      ...evidenceErrors.map(value => h('p', { key: value, role: 'alert' }, value)),
      detail.status !== 'cancelled' && detail.status !== 'expired' && h('form', { onSubmit: saveCancel },
        h('h4', null, 'Cancel whole Reservation'),
        h('p', null, winner ? `Received winning payment: ${money(received, detail.currency)}. Refund work is processed separately.`
          : detail.status === 'pending_payment' ? 'No payment received. Refund amount must be 0.' : 'Winning payment evidence is unavailable.'),
        h('fieldset', { disabled: busy || unknownCancel || unknownRetry || (detail.status === 'confirmed' && !winner) },
          h('label', null, `Refund amount (${detail.currency} minor units)`, h('input', { 'aria-label': `Refund amount (${detail.currency} minor units)`, type: 'number', min: 0, max: received, step: 1,
            value: refundAmount, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setRefundAmount(event.target.value) })),
          h('label', null, 'Audit reason', h('textarea', { 'aria-label': 'Audit reason', value: reason, maxLength: 1000,
            onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setReason(event.target.value) })),
          h('button', { type: 'submit' }, 'Cancel Reservation')),
)));
}

type Entry = AdminRouteDefinition<string, string, string, string, undefined, ReactNode>;
export const bookingReservationAdminContribution: AdminContribution<Entry> = {
  key: 'booking-reservation',
  routes: [{ path: 'reservations', navLabel: 'Reservations', icon: 'calendar', section: 'booking', title: 'Reservations',
    subtitle: 'Review stays, payments, refunds, and notifications', module: 'booking-reservation',
    permissions: ['booking-reservation:operator-read'], render: () => h(ReservationAdminPage) }],
};
