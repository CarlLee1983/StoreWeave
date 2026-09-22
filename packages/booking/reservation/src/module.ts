import packageJson from '../package.json';
import { bindModuleCapability, defineModule, type BoundModuleCapability } from '@storeweave/kernel';
import type { Keyring } from '@storeweave/crypto';
import {
  BOOKING_AVAILABILITY_QUOTE_RESERVATION_CAPABILITY,
  type BookingAvailabilityQuoteReservation,
  BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY,
  type BookingAvailabilityRoomNightOperations,
} from '@storeweave/booking-availability';
import { createBookingReservationCommand, createBookingReservationHandler } from './commands';
import {
  createRecordBookingReservationPaymentResultHandler,
  createStartBookingReservationPaymentHandler,
  getBookingReservationPaymentAttemptForProcessingHandler,
  getBookingReservationPaymentAttemptForProcessingQuery,
  recordBookingReservationPaymentResultCommand,
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
  updateBookingReservationDetailsCommand,
} from './management';
import { createExpireBookingReservationHandler, expireBookingReservationCommand } from './expiry';
import {
  createAnonymizeExpiredBookingReservationPiiJob,
  createExpireBookingReservationJob,
  createProcessBookingReservationPaymentJob,
  ANONYMIZE_EXPIRED_BOOKING_RESERVATION_PII_JOB,
  anonymizeExpiredBookingReservationPiiJobPayload,
  EXPIRE_BOOKING_RESERVATION_JOB,
  expireBookingReservationJobPayload,
  PROCESS_BOOKING_RESERVATION_PAYMENT_JOB,
  processBookingReservationPaymentJobPayload,
} from './jobs';
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
  return defineModule({
    name: 'booking-reservation', version: packageJson.version, baseVersionRange: '^1.0.0',
    dependencies: { required: [
      { name: 'platform', versionRange: '^0.1.0' },
      { name: 'booking-availability', versionRange: '^0.1.0' },
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
    data: { owns: ['booking_reservation_reservations', 'booking_reservation_payment_attempts'] },
    migrations: bookingReservationMigrations,
    permissions: [
      { key: 'booking-reservation:create', description: 'Create a Booking Reservation', owner: 'booking-reservation' },
      { key: 'booking-reservation:pay', description: 'Start a Booking Reservation payment attempt', owner: 'booking-reservation' },
      { key: 'booking-reservation:system-write', description: 'Expire a Booking Reservation', owner: 'booking-reservation' },
      { key: 'booking-reservation:claim', description: 'Claim a Reservation for the authenticated Account', owner: 'booking-reservation' },
      { key: 'booking-reservation:read-self', description: 'Read an owned Reservation', owner: 'booking-reservation' },
      { key: 'booking-reservation:read-managed', description: 'Read a Reservation with valid management access', owner: 'booking-reservation' },
      { key: 'booking-reservation:manage-self', description: 'Update authorized Booker details', owner: 'booking-reservation' },
      { key: 'booking-reservation:retention-write', description: 'Anonymize expired Reservation personal data', owner: 'booking-reservation' },
    ],
    commands: [
      { descriptor: createBookingReservationCommand, handler: createBookingReservationHandler(availabilityBinding.value) },
      { descriptor: startBookingReservationPaymentCommand, handler: createStartBookingReservationPaymentHandler(paymentProvider) },
      { descriptor: recordBookingReservationPaymentResultCommand, handler: createRecordBookingReservationPaymentResultHandler() },
      { descriptor: expireBookingReservationCommand, handler: createExpireBookingReservationHandler(roomNightOperationsBinding.value) },
      { descriptor: claimBookingReservationCommand, handler: createClaimBookingReservationHandler(access) },
      { descriptor: updateBookingReservationDetailsCommand, handler: createUpdateBookingReservationDetailsHandler(access) },
      { descriptor: anonymizeExpiredBookingReservationPiiCommand, handler: createAnonymizeExpiredBookingReservationPiiHandler(validatedRetentionPolicy) },
    ],
    queries: [
      { descriptor: getBookingReservationPaymentAttemptForProcessingQuery, handler: getBookingReservationPaymentAttemptForProcessingHandler },
      { descriptor: getOwnedBookingReservationQuery, handler: getOwnedBookingReservationHandler },
      { descriptor: getManagedBookingReservationQuery, handler: createGetManagedBookingReservationHandler(access) },
    ],
    jobs: [{
      type: PROCESS_BOOKING_RESERVATION_PAYMENT_JOB,
      handler: createProcessBookingReservationPaymentJob(paymentProvider),
      jobContractV1: { currentVersion: 1, versions: { 1: processBookingReservationPaymentJobPayload } },
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
  });
}
