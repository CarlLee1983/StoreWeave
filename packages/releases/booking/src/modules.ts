import { bindModuleCapability, type PlatformModule } from '@storeweave/kernel';
import type { PaymentProviderV2, ProviderRegistry } from '@storeweave/extension-sdk';
import type { ReleaseRoleCatalog } from '@storeweave/authorization';
import { createSiteModule, siteSettingsService, navigationItem } from '@storeweave/site';
import { createContentModule } from '@storeweave/content';
import { createAuthModule } from '@storeweave/auth';
import { createBookingPropertyModule, bookingPropertyRead } from '@storeweave/booking-property';
import { BOOKING_PROPERTY_READ_CAPABILITY, BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY, bookingAvailabilityRoomNightOperations, composeBookingAvailabilityRuntime } from '@storeweave/booking-availability';
import {
  BOOKING_RESERVATION_ACCESS_GRANT_PURPOSE, BOOKING_RESERVATION_CHECKOUT_CREDENTIAL_PURPOSE,
  createBookingReservationAccess, createBookingReservationModule,
  type BookingReservationAccess, type BookingReservationPaymentProvider,
} from '@storeweave/booking-reservation';
import { mockPaymentExtension } from '@storeweave/ext-mock-payment';
import type { BookingConfig } from './config';

export const BOOKING_ROLES: ReleaseRoleCatalog = {
  admin: { permissions: ['*'], tokenAllowed: true, account: { actorType: 'user', sessionTtl: 'operator', minPasswordLength: 12, adminCreatable: true, mfa: 'required' } },
  staff: { permissions: [
    'booking-property:read', 'booking-property:manage', 'booking-availability:read', 'booking-availability:manage',
    'booking-reservation:operator-read', 'booking-reservation:cancel', 'booking-reservation:refund-retry',
    'booking-reservation:refund-read', 'booking-reservation:notification-read', 'content:read', 'content:write',
    'site:public-read', 'site:manage', 'users:read', 'jobs:read', 'jobs:write', 'media:read', 'media:write',
  ], tokenAllowed: true, account: { actorType: 'user', sessionTtl: 'operator', minPasswordLength: 12, adminCreatable: true, mfa: 'required' } },
  member: { permissions: [
    'booking-property:public-read', 'booking-availability:quote', 'booking-reservation:create',
    'booking-reservation:pay', 'booking-reservation:claim', 'booking-reservation:read-self',
    'booking-reservation:read-managed', 'booking-reservation:manage-self', 'content:public-read',
    'contact:submit', 'site:public-read', 'notifications:inbox',
  ], tokenAllowed: false, account: { actorType: 'user', sessionTtl: 'customer', minPasswordLength: 8, adminCreatable: false, selfServiceRegistration: true } },
  visitor: { permissions: [
    'booking-property:public-read', 'booking-availability:quote', 'booking-reservation:create',
    'booking-reservation:pay', 'booking-reservation:read-managed', 'content:public-read',
    'contact:submit', 'site:public-read',
  ], tokenAllowed: false, account: false },
};

const BOOKING_NAVIGATION = [
  navigationItem({ menu: 'primary', label: '首頁', href: '/', position: 0 }),
  navigationItem({ menu: 'primary', label: '住宿地點', href: '/property', position: 10 }),
  navigationItem({ menu: 'primary', label: '房型', href: '/rooms', position: 20 }),
  navigationItem({ menu: 'primary', label: '搜尋住宿', href: '/booking/search', position: 30 }),
];

function reservationAccessDelegate(): { access: BookingReservationAccess; bind: (access: BookingReservationAccess) => void } {
  let bound: BookingReservationAccess | undefined;
  const requireBound = () => {
    if (!bound) throw new Error('Booking Reservation runtime security is not bound');
    return bound;
  };
  return {
    access: {
      checkout: {
        prepare: (...args) => requireBound().checkout.prepare(...args),
        present: (...args) => requireBound().checkout.present(...args),
        authorizePayment: (...args) => requireBound().checkout.authorizePayment(...args),
      },
      issueGrant: (...args) => requireBound().issueGrant(...args),
      redeemGrant: (...args) => requireBound().redeemGrant(...args),
      authorizeManagement: (...args) => requireBound().authorizeManagement(...args),
    },
    bind: access => { if (bound) throw new Error('Booking Reservation runtime security may only be bound once'); bound = access; },
  };
}

export function bookingModules(config: BookingConfig, providers: ProviderRegistry): PlatformModule[] {
  const propertyBinding = bindModuleCapability('booking-property', BOOKING_PROPERTY_READ_CAPABILITY, bookingPropertyRead);
  const availability = composeBookingAvailabilityRuntime(propertyBinding, { maxRoomsPerRequest: config.booking.maxRoomsPerRequest });
  const roomNights = bindModuleCapability('booking-availability', BOOKING_AVAILABILITY_ROOM_NIGHT_OPERATIONS_CAPABILITY, bookingAvailabilityRoomNightOperations);
  const access = reservationAccessDelegate();
  const payment: BookingReservationPaymentProvider = {
    id: 'mock-payment',
    paymentMethods: () => providers.get<PaymentProviderV2>('payment', 'mock-payment').paymentMethods(),
    initiate: input => providers.get<PaymentProviderV2>('payment', 'mock-payment').initiate(input),
    refund: input => providers.get<PaymentProviderV2>('payment', 'mock-payment').refund(input),
  };
  const reservation = createBookingReservationModule(availability.quoteReservation, roomNights, access.access,
    { reservationPiiRetentionDays: config.booking.reservationPiiRetentionDays }, payment,
    config.booking.operatorAlertEmail);
  const securedReservation: PlatformModule = {
    ...reservation,
    runtimeSecurity: { signingKeyPurposes: [BOOKING_RESERVATION_ACCESS_GRANT_PURPOSE, BOOKING_RESERVATION_CHECKOUT_CREDENTIAL_PURPOSE] },
    bindRuntimeSecurity: security => {
      if (!security.keyring) throw new TypeError('Booking Reservation requires a configured signing Keyring');
      access.bind(createBookingReservationAccess(security.keyring));
    },
  };
  return [
    createSiteModule({ defaultNavigation: BOOKING_NAVIGATION, ownsHomePage: true }),
    createContentModule({ contactNotificationRecipient: bindModuleCapability('platform-site', 'platform.site.contact-notification-recipient', siteSettingsService.contactNotificationEmail) }),
    createAuthModule({ signedInActorTypes: ['user'] }),
    createBookingPropertyModule(), availability.module, securedReservation,
  ];
}

export const BOOKING_EXTENSIONS = { 'mock-payment': mockPaymentExtension };
