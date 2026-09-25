import type { NotificationTemplate } from '@storeweave/notifications';
import type { BookingReservationNotificationTemplateId } from './types';

export const BOOKING_RESERVATION_NOTIFICATION_TEMPLATES: Record<BookingReservationNotificationTemplateId, NotificationTemplate> = {
  'booking.reservation.confirmed': {
    id: 'booking.reservation.confirmed', version: 1,
    email: {
      subject: 'Your reservation is confirmed',
      text: 'Your reservation {reservationId} is confirmed. Use this short-lived access grant before {accessGrantExpiresAt}: {accessGrant}',
      html: '<p>Your reservation <strong>{reservationId}</strong> is confirmed.</p><p>Use this short-lived access grant before {accessGrantExpiresAt}: <code>{accessGrant}</code></p>',
    },
  },
  'booking.reservation.cancelled': {
    id: 'booking.reservation.cancelled', version: 1,
    email: {
      subject: 'Your reservation was cancelled',
      text: 'Your reservation {reservationId} was cancelled. Use this short-lived access grant before {accessGrantExpiresAt}: {accessGrant}',
      html: '<p>Your reservation <strong>{reservationId}</strong> was cancelled.</p><p>Use this short-lived access grant before {accessGrantExpiresAt}: <code>{accessGrant}</code></p>',
    },
  },
  'booking.reservation.payment-expiring': {
    id: 'booking.reservation.payment-expiring', version: 1,
    email: {
      subject: 'Payment for your reservation is due soon',
      text: 'Payment for reservation {reservationId} is due by {paymentExpiresAt}. Use this short-lived access grant before {accessGrantExpiresAt}: {accessGrant}',
      html: '<p>Payment for reservation <strong>{reservationId}</strong> is due by {paymentExpiresAt}.</p><p>Use this short-lived access grant before {accessGrantExpiresAt}: <code>{accessGrant}</code></p>',
    },
  },
  'booking.reservation.late-payment': {
    id: 'booking.reservation.late-payment', version: 1,
    email: {
      subject: 'Late reservation payment requires review',
      text: 'Late payment for reservation {reservationId}, attempt {paymentAttemptId}, has refund {refundId}. Review the refund and notification delivery records.',
      html: '<p>Late payment for reservation <strong>{reservationId}</strong>, attempt <strong>{paymentAttemptId}</strong>, has refund <strong>{refundId}</strong>.</p><p>Review the refund and notification delivery records.</p>',
    },
  },
};

/** Deliberately separate from lifecycle-event templates: this is user-requested. */
export const BOOKING_RESERVATION_ACCESS_GRANT_RESEND_TEMPLATE: NotificationTemplate = {
  id: 'booking.reservation.access-grant-resend', version: 1,
  email: {
    subject: 'Your reservation access link',
    text: 'Use this short-lived access grant for reservation {reservationId} before {accessGrantExpiresAt}: {accessGrant}',
    html: '<p>Use this short-lived access grant for reservation <strong>{reservationId}</strong> before {accessGrantExpiresAt}: <code>{accessGrant}</code></p>',
  },
};
