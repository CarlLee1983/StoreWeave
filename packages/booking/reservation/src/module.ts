import packageJson from '../package.json';
import { bindModuleCapability, defineModule, type BoundModuleCapability } from '@storeweave/kernel';
import type { Keyring } from '@storeweave/crypto';
import type { NotificationsPort } from '@storeweave/notifications';
import {
  BOOKING_AVAILABILITY_QUOTE_RESERVATION_CAPABILITY,
  type BookingAvailabilityQuoteReservation,
  BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY,
  type BookingAvailabilityRoomNightOperations,
} from '@storeweave/booking-availability';
import { createBookingReservationCommand, createBookingReservationHandler } from './commands';
import {
  createRecordBookingReservationPaymentResultHandler,
  createRecordVerifiedBookingPaymentOutcomeHandler,
  createStartBookingReservationPaymentHandler,
  getBookingReservationPaymentAttemptForProcessingHandler,
  getBookingReservationPaymentAttemptForProcessingQuery,
  recordBookingReservationPaymentResultCommand,
  recordVerifiedBookingPaymentOutcomeCommand,
  startBookingReservationPaymentCommand,
  type BookingReservationPaymentProvider,
} from './payment-attempts';
import {
  claimBookingReservationCommand,
  createClaimBookingReservationHandler,
  createGetManagedBookingReservationHandler,
  createUpdateBookingReservationDetailsHandler,
  getManagedBookingReservationQuery,
  getOwnedBookingReservationHandler,
  getOwnedBookingReservationQuery,
  createResendBookingReservationAccessGrantHandler,
  resendBookingReservationAccessGrantCommand,
  updateBookingReservationDetailsCommand,
} from './management';
import { createExpireBookingReservationHandler, expireBookingReservationCommand } from './expiry';
import {
  cancelBookingReservationByOperatorCommand,
  cancelBookingReservationSelfCommand,
  createCancelBookingReservationByOperatorHandler,
  createCancelBookingReservationSelfHandler,
} from './cancellation';
import {
  createAnonymizeExpiredBookingReservationPiiJob,
  createExpireBookingReservationJob,
  createProcessBookingReservationPaymentJob,
  createProcessBookingReservationRefundJob,
  createReconcileBookingReservationRefundsJob,
  ANONYMIZE_EXPIRED_BOOKING_RESERVATION_PII_JOB,
  anonymizeExpiredBookingReservationPiiJobPayload,
  EXPIRE_BOOKING_RESERVATION_JOB,
  expireBookingReservationJobPayload,
  PROCESS_BOOKING_RESERVATION_PAYMENT_JOB,
  processBookingReservationPaymentJobPayload,
  PROCESS_BOOKING_RESERVATION_REFUND_JOB,
  processBookingReservationRefundJobPayload,
  RECONCILE_BOOKING_RESERVATION_REFUNDS_JOB,
  reconcileBookingReservationRefundsJobPayload,
} from './jobs';
import {
  createRecordBookingReservationRefundInvocationHandler,
  createRequestRequiredBookingReservationRefundHandler,
  createRetryBookingReservationRefundHandler,
  getBookingReservationRefundForProcessingHandler,
  getBookingReservationRefundForProcessingQuery,
  listBookingReservationRefundsHandler,
  listBookingReservationRefundsQuery,
  recordBookingReservationRefundInvocationCommand,
  requestRequiredBookingReservationRefundCommand,
  retryBookingReservationRefundCommand,
  reconcileBookingReservationRefundsCommand,
  createReconcileBookingReservationRefundsHandler,
} from './refunds';
import {
  bookingReservationRetentionPolicySchema,
  createAnonymizeExpiredBookingReservationPiiHandler,
  type BookingReservationRetentionPolicy,
  anonymizeExpiredBookingReservationPiiCommand,
} from './retention';
import { bookingReservationMigrations } from './migrations';
import {
  BOOKING_RESERVATION_ACCESS_CAPABILITY,
  createBookingReservationAccess,
  type BookingReservationAccess,
} from './access';
import {
  bookingReservationCancelledV1,
  bookingReservationConfirmedV1,
  bookingReservationEvents,
  bookingReservationPaymentExpiringV1,
} from './events';
import {
  createListBookingReservationNotificationsHandler,
  createMaterializeBookingReservationNotificationHandler,
  createRecordBookingReservationNotificationMappingFailureHandler,
  listBookingReservationNotificationsQuery,
  materializeBookingReservationNotificationCommand,
  recordBookingReservationNotificationMappingFailureCommand,
  PermanentBookingReservationNotificationMappingError,
} from './notifications';

function queueNotification(input: unknown, eventId: string, template: string) {
  return async (_event: unknown, context: { executeCommand?: (name: string, input: unknown, idempotencyKey: string) => Promise<unknown> }) => {
    if (!context.executeCommand) throw new Error('Reservation notification subscriber lacks core command access');
    try {
      await context.executeCommand('booking.reservation.materializeNotification', input,
        `booking-reservation:notification:${eventId}:${template}`);
    } catch (error) {
      // A mapping error must be observable without coupling it to the state
      // transition which emitted this event. Keep the failure code fixed and safe.
      const failure = error instanceof PermanentBookingReservationNotificationMappingError ? 'permanent' : 'retryable';
      await context.executeCommand('booking.reservation.recordNotificationMappingFailure', {
        eventId, reservationId: (input as { reservationId: string }).reservationId,
        kind: (input as { kind: string }).kind,
        failure,
      },
        `booking-reservation:notification-failure:${eventId}:${template}:${failure}`);
      throw error;
    }
  };
}

export function bindBookingReservationAccess(keyring: Keyring): BoundModuleCapability<BookingReservationAccess> {
  return bindModuleCapability(
    'booking-reservation',
    BOOKING_RESERVATION_ACCESS_CAPABILITY,
    createBookingReservationAccess(keyring),
  );
}

export function createBookingReservationModule(
  availabilityBinding: BoundModuleCapability<BookingAvailabilityQuoteReservation>,
  roomNightOperationsBinding: BoundModuleCapability<BookingAvailabilityRoomNightOperations>,
  access: BookingReservationAccess,
  retentionPolicy: BookingReservationRetentionPolicy,
  paymentProvider: BookingReservationPaymentProvider,
) {
  const validatedRetentionPolicy = bookingReservationRetentionPolicySchema.parse(retentionPolicy);
  let notificationPort: NotificationsPort | undefined;
  const notifications = () => {
    if (!notificationPort) throw new Error('Booking Reservation module was composed without the base notification capability');
    return notificationPort;
  };
  return defineModule({
    name: 'booking-reservation', version: packageJson.version, baseVersionRange: '^1.0.0',
    dependencies: { required: [
      { name: 'platform', versionRange: '^0.1.0' },
      { name: 'booking-availability', versionRange: '^0.1.0' },
      { name: 'platform-notifications', versionRange: '^0.1.0' },
    ] },
    capabilities: {
      provides: [BOOKING_RESERVATION_ACCESS_CAPABILITY],
      required: [{
        from: 'booking-availability',
        capability: BOOKING_AVAILABILITY_QUOTE_RESERVATION_CAPABILITY,
        versionRange: '^0.1.0',
      }, {
        from: 'booking-availability',
        capability: BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY,
        versionRange: '^0.1.0',
      }],
      bound: [availabilityBinding, roomNightOperationsBinding],
    },
    data: { owns: ['booking_reservation_reservations', 'booking_reservation_payment_attempts', 'booking_reservation_refunds', 'booking_reservation_refund_invocations', 'booking_reservation_notification_links'] },
    migrations: bookingReservationMigrations,
    bindPorts: (ports) => { notificationPort = ports.notifications; },
    permissions: [
      { key: 'booking-reservation:create', description: 'Create a Booking Reservation', owner: 'booking-reservation' },
      { key: 'booking-reservation:pay', description: 'Start a Booking Reservation payment attempt', owner: 'booking-reservation' },
      { key: 'booking-reservation:system-write', description: 'Expire a Booking Reservation', owner: 'booking-reservation' },
      { key: 'booking-reservation:claim', description: 'Claim a Reservation for the authenticated Account', owner: 'booking-reservation' },
      { key: 'booking-reservation:read-self', description: 'Read an owned Reservation', owner: 'booking-reservation' },
      { key: 'booking-reservation:read-managed', description: 'Read a Reservation with valid management access', owner: 'booking-reservation' },
      { key: 'booking-reservation:manage-self', description: 'Update authorized Booker details', owner: 'booking-reservation' },
      { key: 'booking-reservation:cancel', description: 'Cancel a Reservation as an operator', owner: 'booking-reservation' },
      { key: 'booking-reservation:retention-write', description: 'Anonymize expired Reservation personal data', owner: 'booking-reservation' },
      { key: 'booking-reservation:refund-retry', description: 'Retry a failed Reservation refund', owner: 'booking-reservation' },
      { key: 'booking-reservation:refund-read', description: 'Read Reservation refund evidence', owner: 'booking-reservation' },
      { key: 'booking-reservation:notification-read', description: 'Read Reservation notification evidence', owner: 'booking-reservation' },
    ],
    commands: [
      { descriptor: createBookingReservationCommand, handler: createBookingReservationHandler(availabilityBinding.value, access.checkout) },
      { descriptor: startBookingReservationPaymentCommand, handler: createStartBookingReservationPaymentHandler(paymentProvider, access.checkout) },
      { descriptor: recordBookingReservationPaymentResultCommand, handler: createRecordBookingReservationPaymentResultHandler() },
      { descriptor: recordVerifiedBookingPaymentOutcomeCommand, handler: createRecordVerifiedBookingPaymentOutcomeHandler() },
      { descriptor: cancelBookingReservationSelfCommand, handler: createCancelBookingReservationSelfHandler(access, roomNightOperationsBinding.value) },
      { descriptor: cancelBookingReservationByOperatorCommand, handler: createCancelBookingReservationByOperatorHandler(roomNightOperationsBinding.value) },
      { descriptor: requestRequiredBookingReservationRefundCommand, handler: createRequestRequiredBookingReservationRefundHandler() },
      { descriptor: recordBookingReservationRefundInvocationCommand, handler: createRecordBookingReservationRefundInvocationHandler() },
      { descriptor: retryBookingReservationRefundCommand, handler: createRetryBookingReservationRefundHandler() },
      { descriptor: reconcileBookingReservationRefundsCommand, handler: createReconcileBookingReservationRefundsHandler() },
      { descriptor: expireBookingReservationCommand, handler: createExpireBookingReservationHandler(roomNightOperationsBinding.value) },
      { descriptor: claimBookingReservationCommand, handler: createClaimBookingReservationHandler(access) },
      { descriptor: updateBookingReservationDetailsCommand, handler: createUpdateBookingReservationDetailsHandler(access) },
      { descriptor: resendBookingReservationAccessGrantCommand, handler: createResendBookingReservationAccessGrantHandler(access, notifications) },
      { descriptor: anonymizeExpiredBookingReservationPiiCommand, handler: createAnonymizeExpiredBookingReservationPiiHandler(validatedRetentionPolicy) },
      { descriptor: materializeBookingReservationNotificationCommand, handler: createMaterializeBookingReservationNotificationHandler({ access, notifications, locale: 'en' }) },
      { descriptor: recordBookingReservationNotificationMappingFailureCommand, handler: createRecordBookingReservationNotificationMappingFailureHandler() },
    ],
    queries: [
      { descriptor: getBookingReservationPaymentAttemptForProcessingQuery, handler: getBookingReservationPaymentAttemptForProcessingHandler },
      { descriptor: getBookingReservationRefundForProcessingQuery, handler: getBookingReservationRefundForProcessingHandler },
      { descriptor: listBookingReservationRefundsQuery, handler: listBookingReservationRefundsHandler },
      { descriptor: getOwnedBookingReservationQuery, handler: getOwnedBookingReservationHandler },
      { descriptor: getManagedBookingReservationQuery, handler: createGetManagedBookingReservationHandler(access) },
      { descriptor: listBookingReservationNotificationsQuery, handler: createListBookingReservationNotificationsHandler(notifications) },
    ],
    events: bookingReservationEvents,
    jobs: [{
      type: PROCESS_BOOKING_RESERVATION_PAYMENT_JOB,
      handler: createProcessBookingReservationPaymentJob(paymentProvider),
      jobContractV1: { currentVersion: 1, versions: { 1: processBookingReservationPaymentJobPayload } },
    }, {
      type: RECONCILE_BOOKING_RESERVATION_REFUNDS_JOB,
      handler: createReconcileBookingReservationRefundsJob(),
      jobContractV1: { currentVersion: 1, versions: { 1: reconcileBookingReservationRefundsJobPayload } },
      schedule: { everyMs: 60 * 60 * 1000 },
    }, {
      type: PROCESS_BOOKING_RESERVATION_REFUND_JOB,
      handler: createProcessBookingReservationRefundJob(paymentProvider),
      jobContractV1: { currentVersion: 1, versions: { 1: processBookingReservationRefundJobPayload } },
    }, {
      type: EXPIRE_BOOKING_RESERVATION_JOB,
      handler: createExpireBookingReservationJob(),
      jobContractV1: { currentVersion: 1, versions: { 1: expireBookingReservationJobPayload } },
    }, {
      type: ANONYMIZE_EXPIRED_BOOKING_RESERVATION_PII_JOB,
      handler: createAnonymizeExpiredBookingReservationPiiJob(),
      jobContractV1: { currentVersion: 1, versions: { 1: anonymizeExpiredBookingReservationPiiJobPayload } },
      schedule: { everyMs: 24 * 60 * 60 * 1000 },
    }],
    subscribers: [
      { eventName: bookingReservationConfirmedV1.name, handler: (event, context) => queueNotification({
        eventId: event.id, kind: 'confirmed', reservationId: event.payload.reservationId,
        paymentAttemptId: event.payload.paymentAttemptId, confirmedAt: event.payload.confirmedAt.toISOString(),
      }, event.id, 'booking.reservation.confirmed')(event, context) },
      { eventName: bookingReservationCancelledV1.name, handler: (event, context) => queueNotification({
        eventId: event.id, kind: 'cancelled', reservationId: event.payload.reservationId,
        cancelledAt: event.payload.cancelledAt.toISOString(),
      }, event.id, 'booking.reservation.cancelled')(event, context) },
      { eventName: bookingReservationPaymentExpiringV1.name, handler: (event, context) => queueNotification({
        eventId: event.id, kind: 'payment-expiring', reservationId: event.payload.reservationId,
        paymentAttemptId: event.payload.paymentAttemptId, expiresAt: event.payload.expiresAt.toISOString(),
      }, event.id, 'booking.reservation.payment-expiring')(event, context) },
    ],
  });
}
