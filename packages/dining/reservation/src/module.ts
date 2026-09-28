import packageJson from '../package.json';
import { defineModule } from '@storeweave/kernel';
import type { NotificationsPort } from '@storeweave/notifications';
import {
  createTableTypeCommand, createTableTypeHandler, createVenueCommand, createVenueHandler,
  setDateOverrideCommand, setDateOverrideHandler, setWeeklyStartsCommand, setWeeklyStartsHandler,
  updateTableTypeCommand, updateTableTypeHandler, updateVenueCommand, updateVenueHandler,
} from './commands';
import { diningReservationMigrations } from './migrations';
import { createSubmitDiningRequestHandler, DINING_RATE_CLEANUP_MS, expireDiningRateEventsCommand, expireDiningRateEventsHandler,
  getDiningRequestHandler, getDiningRequestQuery, publicRequestPolicySchema,
  submitDiningRequestCommand, type PublicRequestPolicy } from './requests';
import {
  getOpenStartsHandler, getOpenStartsQuery, getVenueHandler, getVenueQuery,
  listDateOverridesHandler, listDateOverridesQuery, listTableTypesHandler, listTableTypesQuery,
  listWeeklyStartsHandler, listWeeklyStartsQuery,
} from './queries';

export function createDiningReservationModule(publicRequestPolicy: PublicRequestPolicy) {
  const policy = publicRequestPolicySchema.parse(publicRequestPolicy);
  let notificationPort: NotificationsPort | undefined;
  const notifications = () => {
    if (!notificationPort) throw new Error('Dining Reservation requires the Base notification capability');
    return notificationPort;
  };
  return defineModule({
    name: 'dining-reservation', version: packageJson.version, baseVersionRange: '^1.0.0',
    dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' },
      { name: 'platform-notifications', versionRange: '^0.1.0' }] },
    bindPorts: ports => { notificationPort = ports.notifications; },
    data: { owns: [
      'dining_reservation_venues', 'dining_reservation_table_types',
      'dining_reservation_weekly_starts', 'dining_reservation_date_overrides',
      'dining_reservation_request_snapshots', 'dining_reservation_capacity_commitments',
      'dining_reservation_requests', 'dining_reservation_request_rate_events',
    ] },
    migrations: diningReservationMigrations,
    permissions: [
      { key: 'dining-reservation:read', description: 'Read Dining settings and schedule', owner: 'dining-reservation' },
      { key: 'dining-reservation:manage', description: 'Manage Dining settings and schedule', owner: 'dining-reservation' },
      { key: 'dining-reservation:request', description: 'Submit a public Dining request', owner: 'dining-reservation' },
      { key: 'dining-reservation:availability', description: 'Read public Dining available starts', owner: 'dining-reservation' },
      { key: 'dining-reservation:system-write', description: 'Expire Dining rate events', owner: 'dining-reservation' },
    ],
    commands: [
      { descriptor: createVenueCommand, handler: createVenueHandler },
      { descriptor: updateVenueCommand, handler: updateVenueHandler },
      { descriptor: createTableTypeCommand, handler: createTableTypeHandler },
      { descriptor: updateTableTypeCommand, handler: updateTableTypeHandler },
      { descriptor: setWeeklyStartsCommand, handler: setWeeklyStartsHandler },
      { descriptor: setDateOverrideCommand, handler: setDateOverrideHandler },
      { descriptor: submitDiningRequestCommand, handler: createSubmitDiningRequestHandler(policy, notifications) },
      { descriptor: expireDiningRateEventsCommand, handler: expireDiningRateEventsHandler },
    ],
    queries: [
      { descriptor: getVenueQuery, handler: getVenueHandler },
      { descriptor: listTableTypesQuery, handler: listTableTypesHandler },
      { descriptor: listWeeklyStartsQuery, handler: listWeeklyStartsHandler },
      { descriptor: listDateOverridesQuery, handler: listDateOverridesHandler },
      { descriptor: getOpenStartsQuery, handler: getOpenStartsHandler },
      { descriptor: getDiningRequestQuery, handler: getDiningRequestHandler },
    ],
    jobs: [{ type: 'dining.reservation.expire-rate-events', schedule: { everyMs: DINING_RATE_CLEANUP_MS },
      handler: async (_payload, context) => {
        if (!context.executeCommand) throw new Error('Dining rate cleanup requires the command bridge');
        await context.executeCommand('dining.reservation.expireRateEvents', {}, context.occurrenceId);
      } }],
  });
}
