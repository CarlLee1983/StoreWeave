import React, { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { AdminContribution, AdminRouteDefinition } from '@storeweave/release/admin';
import type { PropertyDto, RoomTypeDto } from './types';
import { bookingPropertyAdminApi, BookingPropertyAdminError, type PropertyInput, type RoomTypeInput, type RoomTypeUpdate } from './admin-api';

const h = React.createElement;
const emptyProperty: PropertyInput = {
  name: '', address: { countryCode: '', postalCode: null, administrativeArea: '', locality: '', addressLine1: '', addressLine2: null },
  timezone: '', currency: '', checkInTime: '15:00', checkOutTime: '11:00', defaultPolicy: { freeCancellationHoursBeforeCheckIn: 24 },
};
const emptyRoom: RoomTypeInput = {
  code: '', name: '', description: null, maxOccupancyPerUnit: 2, beds: [], amenities: [],
  minimumStayNights: 1, maximumStayNights: null, mediaAssetId: null,
};
type RoomForm = RoomTypeInput & { status: RoomTypeDto['status'] };
const emptyRoomForm: RoomForm = { ...emptyRoom, status: 'active' };

function propertyInput(value: PropertyDto): PropertyInput {
  return {
    name: value.name, address: value.address, timezone: value.timezone, currency: value.currency,
    checkInTime: value.checkInTime, checkOutTime: value.checkOutTime, defaultPolicy: value.defaultPolicy,
  };
}
function message(error: unknown): string { return error instanceof Error ? error.message : 'The request failed.'; }
function field(label: string, value: string | number, onChange: (value: string) => void, options: { required?: boolean; type?: string; min?: number; max?: number; readOnly?: boolean; help?: string } = {}): ReactNode {
  return h('label', { style: { display: 'block', marginBottom: 12 } },
    h('span', { style: { display: 'block', marginBottom: 3 } }, label),
    h('input', { 'aria-label': label, value, required: options.required, type: options.type ?? 'text', min: options.min, max: options.max,
      readOnly: options.readOnly, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
      style: { width: '100%', maxWidth: 520, padding: 8 } }),
    options.help && h('small', { style: { display: 'block' } }, options.help));
}
function optional(value: string): string | null { return value.trim() || null; }
function integer(value: string, label: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
}
function validProperty(value: PropertyInput): PropertyInput {
  if (!value.name.trim() || !/^[A-Z]{2}$/.test(value.address.countryCode) || !value.address.administrativeArea.trim()
    || !value.address.locality.trim() || !value.address.addressLine1.trim()) throw new Error('Enter a name and complete address with a two-letter country code.');
  try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }); } catch { throw new Error('Enter a valid IANA time zone.'); }
  if (!Intl.supportedValuesOf('currency').includes(value.currency)) throw new Error('Enter a supported three-letter currency code.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.checkInTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.checkOutTime)
    || value.checkInTime === value.checkOutTime) throw new Error('Enter distinct check-in and check-out times.');
  integer(String(value.defaultPolicy.freeCancellationHoursBeforeCheckIn), 'Cancellation window', 0, 8760);
  return value;
}
function parseBeds(text: string): RoomTypeInput['beds'] {
  if (!text.trim()) return [];
  const allowed = new Set(['single', 'double', 'queen', 'king', 'sofa-bed', 'bunk', 'other']);
  const rows = text.split('\n').map(row => { const [type, count, extra] = row.split(',').map(part => part.trim());
    if (extra !== undefined || !allowed.has(type) || !count) throw new Error('Beds must use one type,count pair per line.');
    return { type: type as RoomTypeInput['beds'][number]['type'], count: integer(count, 'Bed count', 1, 8) }; });
  if (rows.length > 8) throw new Error('Enter at most eight bed groups.');
  return rows;
}
function parseAmenities(text: string): RoomTypeInput['amenities'] {
  if (!text.trim()) return [];
  const rows = text.split('\n').map(row => { const comma = row.indexOf(','); const code = row.slice(0, comma).trim(); const label = row.slice(comma + 1).trim();
    if (comma < 0 || !/^[a-z][a-z0-9_-]{0,49}$/.test(code) || !label || label.length > 100) throw new Error('Amenities must use one code,label pair per line.');
    return { code, label }; });
  if (rows.length > 50 || new Set(rows.map(row => row.code)).size !== rows.length) throw new Error('Enter at most 50 amenities with unique codes.');
  return rows;
}
function validRoom(value: RoomForm, editing: boolean): RoomTypeInput {
  if (!editing && !/^[a-z0-9][a-z0-9-]{1,49}$/.test(value.code)) throw new Error('Room code must use 2–50 lowercase letters, numbers, or hyphens.');
  if (!value.name.trim() || value.name.length > 160 || (value.description?.length ?? 0) > 2000) throw new Error('Check the room name and description.');
  integer(String(value.maxOccupancyPerUnit), 'Maximum occupancy per unit', 1, 32);
  integer(String(value.minimumStayNights), 'Minimum stay', 1, 30);
  if (value.maximumStayNights !== null) {
    integer(String(value.maximumStayNights), 'Maximum stay', 1, 30);
    if (value.maximumStayNights < value.minimumStayNights) throw new Error('Maximum stay must be at least the minimum stay.');
  }
  if (value.mediaAssetId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.mediaAssetId)) throw new Error('Media asset ID must be a UUID.');
  return {
    code: value.code, name: value.name, description: value.description,
    maxOccupancyPerUnit: value.maxOccupancyPerUnit, beds: value.beds, amenities: value.amenities,
    minimumStayNights: value.minimumStayNights, maximumStayNights: value.maximumStayNights,
    mediaAssetId: value.mediaAssetId,
  };
}
function useSaveKey<T>() {
  const pending = useRef<{ input: T; key: string } | null>(null);
  const [unknown, setUnknown] = useState(false);
  return {
    unknown,
    prepare(input: T) {
      if (!pending.current) pending.current = { input, key: crypto.randomUUID() };
      return pending.current;
    },
    settle(error?: unknown) {
      if (!error || (error instanceof BookingPropertyAdminError && error.status >= 400 && error.status < 500)) {
        pending.current = null;
        setUnknown(false);
      } else {
        setUnknown(true);
      }
    },
  };
}

export function PropertyAdminPage() {
  const [property, setProperty] = useState<PropertyDto | null>(null);
  const [form, setForm] = useState<PropertyInput>(emptyProperty);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const saveKey = useSaveKey<PropertyInput>();
  useEffect(() => { let live = true; bookingPropertyAdminApi.getProperty().then(value => { if (live) { setProperty(value); setForm(value ? propertyInput(value) : emptyProperty); setLoading(false); } })
    .catch(cause => { if (live) { setError(message(cause)); setLoading(false); } }); return () => { live = false; }; }, []);
  const address = (key: keyof PropertyInput['address'], value: string) => setForm(old => ({ ...old, address: { ...old.address, [key]: key === 'postalCode' || key === 'addressLine2' ? optional(value) : value } }));
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(''); setNotice('');
    try { const operation = saveKey.prepare(validProperty(form)); setBusy(true);
      const saved = property ? await bookingPropertyAdminApi.updateProperty(operation.input, operation.key) : await bookingPropertyAdminApi.createProperty(operation.input, operation.key);
      saveKey.settle(); setProperty(saved); setForm(propertyInput(saved)); setNotice('Property saved.');
    } catch (cause) { saveKey.settle(cause); setError(message(cause)); } finally { setBusy(false); } };
  if (loading) return h('p', null, 'Loading property…');
  return h('section', null, h('h2', null, property ? 'Edit Property' : 'Create Property'),
    error && h('p', { role: 'alert' }, error), notice && h('p', { role: 'status' }, notice),
    h('form', { onSubmit: submit }, h('fieldset', { disabled: busy || saveKey.unknown },
      field('Property name', form.name, value => setForm(old => ({ ...old, name: value })), { required: true }),
      field('Country code', form.address.countryCode, value => address('countryCode', value.toUpperCase()), { required: true }),
      field('Postal code', form.address.postalCode ?? '', value => address('postalCode', value)),
      field('Administrative area', form.address.administrativeArea, value => address('administrativeArea', value), { required: true }),
      field('Locality', form.address.locality, value => address('locality', value), { required: true }),
      field('Address line 1', form.address.addressLine1, value => address('addressLine1', value), { required: true }),
      field('Address line 2', form.address.addressLine2 ?? '', value => address('addressLine2', value)),
      field('IANA time zone', form.timezone, value => setForm(old => ({ ...old, timezone: value })), { required: true, help: 'Example: Asia/Taipei' }),
      field('Currency code', form.currency, value => setForm(old => ({ ...old, currency: value.toUpperCase() })), { required: true }),
      field('Check-in time', form.checkInTime, value => setForm(old => ({ ...old, checkInTime: value })), { type: 'time', required: true }),
      field('Check-out time', form.checkOutTime, value => setForm(old => ({ ...old, checkOutTime: value })), { type: 'time', required: true }),
      field('Free cancellation hours before check-in', form.defaultPolicy.freeCancellationHoursBeforeCheckIn, value => setForm(old => ({ ...old, defaultPolicy: { freeCancellationHoursBeforeCheckIn: Number(value) } })), { type: 'number', min: 0, max: 8760, required: true }),
      h('button', { type: 'submit' }, busy ? 'Saving…' : 'Save Property')),
      saveKey.unknown && h('button', { type: 'button', disabled: busy, onClick: () => void submit({ preventDefault() {} } as FormEvent) }, 'Retry original save')));
}

export function RoomTypesAdminPage() {
  const [rooms, setRooms] = useState<RoomTypeDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<RoomForm>(emptyRoomForm);
  const [bedsText, setBedsText] = useState('');
  const [amenitiesText, setAmenitiesText] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const saveKey = useSaveKey<RoomTypeInput | RoomTypeUpdate>();
  useEffect(() => { let live = true; bookingPropertyAdminApi.listRoomTypes().then(items => { if (live) { setRooms(items); setLoading(false); } })
    .catch(cause => { if (live) { setError(message(cause)); setLoading(false); } }); return () => { live = false; }; }, []);
  const select = (room: RoomTypeDto | null) => { setSelected(room?.id ?? null); setForm(room ?? emptyRoomForm);
    setBedsText(room?.beds.map(bed => `${bed.type},${bed.count}`).join('\n') ?? '');
    setAmenitiesText(room?.amenities.map(item => `${item.code},${item.label}`).join('\n') ?? ''); setError(''); setNotice(''); };
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(''); setNotice('');
    try { const facts = validRoom({ ...form, beds: parseBeds(bedsText), amenities: parseAmenities(amenitiesText) }, selected !== null);
      const input: RoomTypeInput | RoomTypeUpdate = selected ? { roomTypeId: selected, name: facts.name, description: facts.description,
        maxOccupancyPerUnit: facts.maxOccupancyPerUnit, beds: facts.beds, amenities: facts.amenities,
        minimumStayNights: facts.minimumStayNights, maximumStayNights: facts.maximumStayNights, mediaAssetId: facts.mediaAssetId, status: form.status } : facts;
      const operation = saveKey.prepare(input); setBusy(true);
      const saved = 'roomTypeId' in operation.input
        ? await bookingPropertyAdminApi.updateRoomType(operation.input, operation.key)
        : await bookingPropertyAdminApi.createRoomType(operation.input, operation.key);
      saveKey.settle(); setRooms(old => selected ? old.map(room => room.id === saved.id ? saved : room) : [...old, saved]); select(saved); setNotice('Room type saved.');
    } catch (cause) { saveKey.settle(cause); setError(message(cause)); } finally { setBusy(false); } };
  const change = <K extends keyof RoomForm>(key: K, value: RoomForm[K]) => setForm(old => ({ ...old, [key]: value }));
  if (loading) return h('p', null, 'Loading room types…');
  return h('section', null, h('h2', null, 'Room Types'), error && h('p', { role: 'alert' }, error), notice && h('p', { role: 'status' }, notice),
    h('div', null, h('button', { type: 'button', disabled: busy || saveKey.unknown, onClick: () => select(null) }, 'New Room Type'),
      ...rooms.map(room => h('button', { type: 'button', key: room.id, disabled: busy || saveKey.unknown, onClick: () => select(room), 'aria-pressed': selected === room.id }, `${room.name} (${room.code})`))),
    h('h3', null, selected ? 'Edit Room Type' : 'Create Room Type'),
    h('form', { onSubmit: submit }, h('fieldset', { disabled: busy || saveKey.unknown },
      field('Code', form.code, value => change('code', value), { required: true, readOnly: selected !== null }),
      field('Name', form.name, value => change('name', value), { required: true }),
      h('label', { style: { display: 'block' } }, 'Description', h('textarea', { 'aria-label': 'Description', value: form.description ?? '', onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => change('description', optional(event.target.value)) })),
      field('Maximum occupancy per unit', form.maxOccupancyPerUnit, value => change('maxOccupancyPerUnit', Number(value)), { type: 'number', min: 1, max: 32, required: true }),
      h('label', { style: { display: 'block' } }, 'Beds (one type,count per line)', h('textarea', { 'aria-label': 'Beds', value: bedsText, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setBedsText(event.target.value), placeholder: 'queen,1\nsingle,2' })),
      h('label', { style: { display: 'block' } }, 'Amenities (one code,label per line)', h('textarea', { 'aria-label': 'Amenities', value: amenitiesText, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setAmenitiesText(event.target.value), placeholder: 'wifi,Wi-Fi' })),
      field('Minimum stay nights', form.minimumStayNights, value => change('minimumStayNights', Number(value)), { type: 'number', min: 1, max: 30, required: true }),
      field('Maximum stay nights', form.maximumStayNights ?? '', value => change('maximumStayNights', value === '' ? null : Number(value)), { type: 'number', min: 1, max: 30, help: 'Leave empty for no maximum.' }),
      field('Media asset UUID', form.mediaAssetId ?? '', value => change('mediaAssetId', optional(value)), { help: 'Reference an existing Base Media asset by UUID.' }),
      selected && h('label', null, 'Status', h('select', { 'aria-label': 'Status', value: form.status, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => change('status', event.target.value as RoomForm['status']) },
        h('option', { value: 'active' }, 'Active'), h('option', { value: 'disabled' }, 'Disabled'))),
      h('button', { type: 'submit' }, busy ? 'Saving…' : 'Save Room Type')),
      saveKey.unknown && h('button', { type: 'button', disabled: busy, onClick: () => void submit({ preventDefault() {} } as FormEvent) }, 'Retry original save')));
}

type Entry = AdminRouteDefinition<string, string, string, string, undefined, ReactNode>;
export const bookingPropertyAdminContribution: AdminContribution<Entry> = {
  key: 'booking-property',
  routes: [
    { path: 'property', navLabel: 'Property', icon: 'box', section: 'booking', title: 'Property', subtitle: 'Manage the Booking property',
      module: 'booking-property', permissions: ['booking-property:read', 'booking-property:manage'], render: () => h(PropertyAdminPage) },
    { path: 'room-types', navLabel: 'Room Types', icon: 'clipboard', section: 'booking', title: 'Room Types', subtitle: 'Manage room type facts',
      module: 'booking-property', permissions: ['booking-property:read', 'booking-property:manage'], render: () => h(RoomTypesAdminPage) },
  ],
};
