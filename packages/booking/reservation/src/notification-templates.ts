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
};
