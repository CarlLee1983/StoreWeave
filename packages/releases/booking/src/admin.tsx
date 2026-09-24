import React, { type ReactNode } from 'react';
import { AccountPage } from '../../../../apps/admin/src/pages/AccountPage';
import { bookingPropertyAdminContribution } from '../../../booking/property/src/admin';
import { bookingAvailabilityAdminContribution } from '../../../booking/availability/src/admin';
import { bookingReservationAdminContribution } from '../../../booking/reservation/src/admin';
import {
  assembleAdminProjection, resolveAdminProjection,
  type AdminProjectionAssemblyInput, type AdminProjectionFactory, type AdminRouteDefinition,
} from '../../../platform/release/src/admin';
import {
  BOOKING_TARGET_KEYS, bookingFactoryList, bookingReleaseDefinition, requireBookingFactory,
  validateBookingReleaseDefinition, type BookingFactoryInput,
} from './definition';

export type NavBadge = import('../../../platform/release/src/admin').AdminNavBadge;
export type RouteContext = undefined;
type BookingAdminEntry = AdminRouteDefinition<string, string, string, string, RouteContext, ReactNode>;

// Account is available to every signed-in operator for MFA enrollment.
const accountContribution = {
  key: 'booking-account',
  routes: [{
    path: 'account', navLabel: 'account', icon: 'user', section: 'platform',
    title: 'accountTitle', subtitle: 'accountSubtitle', permissions: [],
    render: () => React.createElement(AccountPage),
  }],
} as const satisfies { readonly key: string; readonly routes: readonly BookingAdminEntry[] };

export const adminProjectionReleaseDefinition = bookingReleaseDefinition;
export const adminProjectionAssembly = {
  requiredContributionKeys: ['booking-property', 'booking-availability', 'booking-reservation', 'booking-account'],
  contributions: [
    bookingPropertyAdminContribution, bookingAvailabilityAdminContribution,
    bookingReservationAdminContribution, accountContribution,
  ],
  defaultRoute: 'property',
} as const satisfies AdminProjectionAssemblyInput<BookingAdminEntry>;

function assembleBookingAdminProjection() { return assembleAdminProjection(adminProjectionAssembly); }
export type BookingAdminProjection = ReturnType<typeof assembleBookingAdminProjection>;
export type Route = BookingAdminProjection['routes'][number]['path'];
export type NavSection = BookingAdminProjection['navSections'][number];
export type RouteDefinition = BookingAdminProjection['routes'][number];

export const adminProjectionFactory: AdminProjectionFactory<BookingAdminProjection> = {
  target: 'admin', key: BOOKING_TARGET_KEYS.admin, resolve: assembleBookingAdminProjection,
};
export const bookingAdminProjectionFactory = adminProjectionFactory;
export function resolveBookingAdminProjection(): BookingAdminProjection;
export function resolveBookingAdminProjection<Contribution>(definition: unknown, factory: BookingFactoryInput<AdminProjectionFactory<Contribution>>): Contribution;
export function resolveBookingAdminProjection<Contribution>(
  definition: unknown = bookingReleaseDefinition,
  factory: BookingFactoryInput<AdminProjectionFactory<Contribution>> = adminProjectionFactory as AdminProjectionFactory<Contribution>,
): Contribution {
  return resolveAdminProjection(validateBookingReleaseDefinition(definition), requireBookingFactory('admin', bookingFactoryList(factory)));
}

export const adminProjection = resolveBookingAdminProjection();
export const ROUTE_TABLE = adminProjection.routes;
export const NAV_SECTIONS = adminProjection.navSections;
export const DEFAULT_ROUTE = adminProjection.defaultRoute;
