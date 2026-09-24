import { collectPages } from '@storeweave/kernel';
import { bookingHttpAdapter } from '../../../../apps/api/src/releases/booking';
import { clearSession } from '../../../../apps/api/src/http/session-clear';
import { createStorefrontController } from '../../../../apps/api/src/storefront/storefront-routes';
import { buildResolveContext, buildThemeContext, renderStorefrontError } from '../../../../apps/api/src/storefront/storefront-context';
import { resolveServerProjection, type ServerProjectionFactory } from '@storeweave/release/server';
import { BOOKING_TARGET_KEYS, bookingFactoryList, bookingReleaseDefinition, requireBookingFactory, validateBookingReleaseDefinition, type BookingFactoryInput } from './definition';
import { release } from './runtime';

/** Add Booking storefront pages at the release boundary; the API adapter remains reusable by SW-137 tests. */
export const httpAdapter: typeof bookingHttpAdapter = {
  ...bookingHttpAdapter,
  anonymousRole: 'visitor',
  controllers(config, { runtime, theme }) {
    const controllers = bookingHttpAdapter.controllers(config, { runtime, theme });
    if (theme) {
      const deps = { runtime, theme, anonymousRole: 'visitor' };
      controllers.push(createStorefrontController(collectPages(runtime.modules), {
        theme,
        buildContext: (req, reply) => buildThemeContext(deps, req, reply),
        resolveContext: (req, reply) => buildResolveContext(deps, req, reply),
        renderError: (req, reply, error) => renderStorefrontError(deps, reply, error, req),
        sessionEffects: {
          start: (req, reply, session) => this.startSession(runtime, req, reply, session),
          clear: (req, reply) => clearSession(runtime, req, reply),
        },
      }));
    }
    return controllers;
  },
};
export interface BookingServerProjection { readonly release: typeof release; readonly httpAdapter: typeof httpAdapter }
export const bookingServerProjectionFactory: ServerProjectionFactory<BookingServerProjection> = {
  target: 'server', key: BOOKING_TARGET_KEYS.server, resolve: () => ({ release, httpAdapter }),
};
export function resolveBookingServerProjection(): BookingServerProjection;
export function resolveBookingServerProjection<Contribution>(definition: unknown, factory: BookingFactoryInput<ServerProjectionFactory<Contribution>>): Contribution;
export function resolveBookingServerProjection<Contribution>(definition: unknown = bookingReleaseDefinition, factory: BookingFactoryInput<ServerProjectionFactory<Contribution>> = bookingServerProjectionFactory as ServerProjectionFactory<Contribution>): Contribution {
  return resolveServerProjection(validateBookingReleaseDefinition(definition), requireBookingFactory('server', bookingFactoryList(factory)));
}
export const serverProjection = resolveBookingServerProjection();
