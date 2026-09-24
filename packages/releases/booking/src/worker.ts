import { resolveWorkerProjection, type WorkerProjectionFactory } from '@storeweave/release/worker';
import { BOOKING_TARGET_KEYS, bookingFactoryList, bookingReleaseDefinition, requireBookingFactory, validateBookingReleaseDefinition, type BookingFactoryInput } from './definition';
import { release } from './runtime';

export interface BookingWorkerProjection { readonly target: 'worker'; readonly release: typeof release }
export const bookingWorkerProjectionFactory: WorkerProjectionFactory<BookingWorkerProjection> = {
  target: 'worker', key: BOOKING_TARGET_KEYS.worker, resolve: () => ({ target: 'worker', release }),
};
export function resolveBookingWorkerProjection(): BookingWorkerProjection;
export function resolveBookingWorkerProjection<Contribution>(definition: unknown, factory: BookingFactoryInput<WorkerProjectionFactory<Contribution>>): Contribution;
export function resolveBookingWorkerProjection<Contribution>(definition: unknown = bookingReleaseDefinition, factory: BookingFactoryInput<WorkerProjectionFactory<Contribution>> = bookingWorkerProjectionFactory as WorkerProjectionFactory<Contribution>): Contribution {
  return resolveWorkerProjection(validateBookingReleaseDefinition(definition), requireBookingFactory('worker', bookingFactoryList(factory)));
}
export const workerProjection = resolveBookingWorkerProjection();
