import packageJson from '../package.json';
import { defineModule } from '@storeweave/kernel';
import {
  createTableTypeCommand, createTableTypeHandler, createVenueCommand, createVenueHandler,
  setDateOverrideCommand, setDateOverrideHandler, setWeeklyStartsCommand, setWeeklyStartsHandler,
  updateTableTypeCommand, updateTableTypeHandler, updateVenueCommand, updateVenueHandler,
} from './commands';
import { diningReservationMigrations } from './migrations';
import {
  getOpenStartsHandler, getOpenStartsQuery, getVenueHandler, getVenueQuery,
  listDateOverridesHandler, listDateOverridesQuery, listTableTypesHandler, listTableTypesQuery,
  listWeeklyStartsHandler, listWeeklyStartsQuery,
} from './queries';

export function createDiningReservationModule() {
  return defineModule({
    name: 'dining-reservation', version: packageJson.version, baseVersionRange: '^1.0.0',
    dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }] },
    data: { owns: [
      'dining_reservation_venues', 'dining_reservation_table_types',
      'dining_reservation_weekly_starts', 'dining_reservation_date_overrides',
      'dining_reservation_request_snapshots', 'dining_reservation_capacity_commitments',
    ] },
    migrations: diningReservationMigrations,
    permissions: [
      { key: 'dining-reservation:read', description: 'Read Dining settings and schedule', owner: 'dining-reservation' },
      { key: 'dining-reservation:manage', description: 'Manage Dining settings and schedule', owner: 'dining-reservation' },
    ],
    commands: [
      { descriptor: createVenueCommand, handler: createVenueHandler },
      { descriptor: updateVenueCommand, handler: updateVenueHandler },
      { descriptor: createTableTypeCommand, handler: createTableTypeHandler },
      { descriptor: updateTableTypeCommand, handler: updateTableTypeHandler },
      { descriptor: setWeeklyStartsCommand, handler: setWeeklyStartsHandler },
      { descriptor: setDateOverrideCommand, handler: setDateOverrideHandler },
    ],
    queries: [
      { descriptor: getVenueQuery, handler: getVenueHandler },
      { descriptor: listTableTypesQuery, handler: listTableTypesHandler },
      { descriptor: listWeeklyStartsQuery, handler: listWeeklyStartsHandler },
      { descriptor: listDateOverridesQuery, handler: listDateOverridesHandler },
      { descriptor: getOpenStartsQuery, handler: getOpenStartsHandler },
    ],
  });
}
