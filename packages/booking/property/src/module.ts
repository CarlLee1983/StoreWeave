import packageJson from '../package.json';
import { defineModule, type PlatformPorts } from '@storeweave/kernel';
import type { MediaReferencesPort } from '@storeweave/media';
import {
  createPropertyCommand, createPropertyHandler, createRoomTypeCommand, createRoomTypeHandler,
  updatePropertyCommand, updatePropertyHandler, updateRoomTypeCommand, updateRoomTypeHandler,
} from './commands';
import { bookingPropertyMigrations } from './migrations';
import { bookingPropertyPages } from './pages';
import {
  getActiveRoomTypeHandler, getActiveRoomTypeQuery, getPropertyHandler, getPropertyQuery,
  getPublicPropertyHandler, getPublicPropertyQuery, getRoomTypeHandler, getRoomTypeQuery,
  getPublicMediaHandler, getPublicMediaQuery,
  listActiveRoomTypesHandler, listActiveRoomTypesQuery, listRoomTypesHandler, listRoomTypesQuery,
} from './queries';

export function createBookingPropertyModule() {
  let mediaReferences: MediaReferencesPort | undefined;
  return defineModule({
    name: 'booking-property', version: packageJson.version, baseVersionRange: '^1.0.0',
    dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }] },
    capabilities: { provides: ['booking.property.read.v1'] },
    data: { owns: ['booking_property_properties', 'booking_property_room_types'] },
    migrations: bookingPropertyMigrations,
    permissions: [
      { key: 'booking-property:read', description: 'Read Booking property facts', owner: 'booking-property' },
      { key: 'booking-property:public-read', description: 'Read the Property and active Room Types used by Booking', owner: 'booking-property' },
      { key: 'booking-property:manage', description: 'Manage the Booking Property and Room Types', owner: 'booking-property' },
    ],
    commands: [
      { descriptor: createPropertyCommand, handler: createPropertyHandler },
      { descriptor: updatePropertyCommand, handler: updatePropertyHandler },
      { descriptor: createRoomTypeCommand, handler: createRoomTypeHandler(() => mediaReferences) },
      { descriptor: updateRoomTypeCommand, handler: updateRoomTypeHandler(() => mediaReferences) },
    ],
    queries: [
      { descriptor: getPublicMediaQuery, handler: getPublicMediaHandler },
      { descriptor: getPropertyQuery, handler: getPropertyHandler },
      { descriptor: getPublicPropertyQuery, handler: getPublicPropertyHandler },
      { descriptor: listActiveRoomTypesQuery, handler: listActiveRoomTypesHandler },
      { descriptor: getActiveRoomTypeQuery, handler: getActiveRoomTypeHandler },
      { descriptor: listRoomTypesQuery, handler: listRoomTypesHandler },
      { descriptor: getRoomTypeQuery, handler: getRoomTypeHandler },
    ],
    pages: bookingPropertyPages,
    bindPorts: (ports: PlatformPorts) => { mediaReferences = ports.media; },
  });
}
