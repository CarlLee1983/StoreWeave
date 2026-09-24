import React, { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { AdminContribution, AdminRouteDefinition } from '@storeweave/release/admin';
import { bookingAvailabilityAdminApi, BookingAvailabilityAdminError, type RoomNightRange } from './admin-api';
import { getRoomNightRangeInputSchema, setBaseNightlyPriceInputSchema, updateRoomNightRangeInputSchema,
  type AvailabilityAdminContext, type SetBaseNightlyPriceInput, type UpdateRoomNightRangeInput } from './types';

const h = React.createElement;
function localToday(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function nextLocalDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day + 1);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
function wholeNumber(value: string, label: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${label} must be a non-negative whole number.`);
  return Number(value);
}
function message(error: unknown): string { return error instanceof Error ? error.message : 'The request failed.'; }
function input(label: string, value: string, change: (value: string) => void, type = 'text', disabled = false): ReactNode {
  return h('label', { style: { display: 'block', marginBottom: 10 } }, label,
    h('input', { 'aria-label': label, type, value, disabled, onChange: (event: React.ChangeEvent<HTMLInputElement>) => change(event.target.value),
      style: { display: 'block', padding: 8, minWidth: 200 } }));
}
function useSaveKey<T>() {
  const pending = useRef<{ input: T; key: string } | null>(null);
  const [unknown, setUnknown] = useState(false);
  return {
    unknown,
    prepare(input: () => T) { if (!pending.current) pending.current = { input: input(), key: crypto.randomUUID() }; return pending.current; },
    settle(error?: unknown) {
      if (!pending.current) { setUnknown(false); return; }
      if (!error || (error instanceof BookingAvailabilityAdminError && error.status >= 400 && error.status < 500)) {
        pending.current = null; setUnknown(false);
      } else setUnknown(true);
    },
  };
}

export function AvailabilityAdminPage() {
  const [context, setContext] = useState<AvailabilityAdminContext | null>(null);
  const [roomTypeId, setRoomTypeId] = useState('');
  const [startLocalDate, setStartLocalDate] = useState('');
  const [endLocalDateExclusive, setEndLocalDateExclusive] = useState('');
  const [range, setRange] = useState<RoomNightRange | null>(null);
  const [basePrice, setBasePrice] = useState('');
  const [sellableUnits, setSellableUnits] = useState('');
  const [overridePrice, setOverridePrice] = useState('');
  const [changeOverride, setChangeOverride] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const viewRequest = useRef(0);
  const baseSave = useSaveKey<SetBaseNightlyPriceInput>();
  const rangeSave = useSaveKey<UpdateRoomNightRangeInput>();
  useEffect(() => { let live = true;
    bookingAvailabilityAdminApi.getAdminContext()
      .then(loadedContext => { if (!live) return;
        setContext(loadedContext); setRoomTypeId(loadedContext?.roomTypes[0]?.id ?? '');
        if (loadedContext) { const today = localToday(loadedContext.propertyTimeZone); setStartLocalDate(today); setEndLocalDateExclusive(nextLocalDate(today)); }
        setLoading(false);
      }).catch(cause => { if (live) { setError(message(cause)); setLoading(false); } });
    return () => { live = false; };
  }, []);
  const selected = context?.roomTypes.find(room => room.id === roomTypeId);
  const queryInput = () => getRoomNightRangeInputSchema.parse({ roomTypeId, startLocalDate, endLocalDateExclusive });
  const view = async (clearFeedback = true) => { const requestId = ++viewRequest.current; setError(''); if (clearFeedback) setNotice(''); setRange(null);
    try { const result = await bookingAvailabilityAdminApi.getRoomNightRange(queryInput());
      if (requestId === viewRequest.current) { setRange(result); setBasePrice(result.baseNightlyPriceMinor?.toString() ?? ''); } }
    catch (cause) { if (requestId === viewRequest.current) setError(message(cause)); }
  };
  const saveBase = async (event: FormEvent) => { event.preventDefault(); setError(''); setNotice('');
    try { const operation = baseSave.prepare(() => setBaseNightlyPriceInputSchema.parse({ roomTypeId, baseNightlyPriceMinor: wholeNumber(basePrice, 'Base nightly price') }));
      setBusy(true); await bookingAvailabilityAdminApi.setBaseNightlyPrice(operation.input, operation.key); baseSave.settle();
      setNotice('Base nightly price saved.'); await view(false);
    } catch (cause) { baseSave.settle(cause); setError(message(cause)); } finally { setBusy(false); }
  };
  const saveRange = async (event: FormEvent) => { event.preventDefault(); setError(''); setNotice('');
    try { const operation = rangeSave.prepare(() => { const facts: Record<string, unknown> = { ...queryInput() };
      if (sellableUnits !== '') facts.sellableUnits = wholeNumber(sellableUnits, 'Sellable units');
      if (changeOverride) facts.nightlyPriceOverrideMinor = overridePrice === '' ? null : wholeNumber(overridePrice, 'Nightly price override');
      return updateRoomNightRangeInputSchema.parse(facts); });
      setBusy(true); await bookingAvailabilityAdminApi.updateRoomNightRange(operation.input, operation.key); rangeSave.settle();
      setNotice('Availability range saved.'); await view(false);
    } catch (cause) { rangeSave.settle(cause); setError(message(cause)); } finally { setBusy(false); }
  };
  if (loading) return h('p', null, 'Loading availability…');
  return h('section', null, h('h2', null, 'Availability'),
    error && h('p', { role: 'alert' }, error), notice && h('p', { role: 'status' }, notice),
    !context && h('p', null, 'Create the Booking Property before managing availability.'),
    context && h(React.Fragment, null,
      h('p', null, `Property local dates: ${context.propertyTimeZone}. Prices use ${context.currency} integer minor units.`),
      h('label', null, 'Room Type', h('select', { 'aria-label': 'Room Type', value: roomTypeId, disabled: busy || baseSave.unknown || rangeSave.unknown,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { viewRequest.current++; setRoomTypeId(event.target.value); setRange(null); } },
      ...context.roomTypes.map(room => h('option', { key: room.id, value: room.id }, room.name)))),
      selected && h('p', null, `Maximum occupancy per unit: ${selected.maxOccupancyPerUnit}`),
      input('Start local date', startLocalDate, value => { viewRequest.current++; setStartLocalDate(value); setRange(null); }, 'date', busy || baseSave.unknown || rangeSave.unknown),
      input('End local date (exclusive)', endLocalDateExclusive, value => { viewRequest.current++; setEndLocalDateExclusive(value); setRange(null); }, 'date', busy || baseSave.unknown || rangeSave.unknown),
      h('button', { type: 'button', disabled: !selected || busy || baseSave.unknown || rangeSave.unknown, onClick: () => void view() }, 'View availability'),
      range && h(React.Fragment, null,
        h('table', null, h('thead', null, h('tr', null,
          ...['Local date', 'Sellable units', 'Reserved units', `Override (${range.currency} minor units)`, `Effective price (${range.currency} minor units)`].map(label => h('th', { key: label }, label)))),
        h('tbody', null, ...range.nights.map(night => h('tr', { key: night.localDate },
          h('td', null, night.localDate), h('td', null, night.sellableUnits), h('td', null, night.reservedUnits),
          h('td', null, night.nightlyPriceOverrideMinor ?? '—'), h('td', null, night.effectiveNightlyPriceMinor ?? '—'))))),
        h('form', { onSubmit: saveBase }, h('fieldset', { disabled: busy || baseSave.unknown },
          input(`Base nightly price (${context.currency} minor units)`, basePrice, setBasePrice, 'number'),
          h('button', { type: 'submit' }, 'Save base price')),
          baseSave.unknown && h('button', { type: 'button', disabled: busy, onClick: () => void saveBase({ preventDefault() {} } as FormEvent) }, 'Retry original base price save')),
        h('form', { onSubmit: saveRange }, h('fieldset', { disabled: busy || rangeSave.unknown },
          input('Sellable units', sellableUnits, setSellableUnits, 'number'),
          h('label', null, h('input', { type: 'checkbox', checked: changeOverride, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setChangeOverride(event.target.checked) }), ' Change nightly price override (empty clears it)'),
          input(`Nightly price override (${context.currency} minor units)`, overridePrice, value => { setOverridePrice(value); setChangeOverride(true); }, 'number'),
          h('button', { type: 'submit' }, 'Save range')),
          rangeSave.unknown && h('button', { type: 'button', disabled: busy, onClick: () => void saveRange({ preventDefault() {} } as FormEvent) }, 'Retry original range save')))));
}

type Entry = AdminRouteDefinition<string, string, string, string, undefined, ReactNode>;
export const bookingAvailabilityAdminContribution: AdminContribution<Entry> = {
  key: 'booking-availability',
  routes: [{ path: 'availability', navLabel: 'Availability', icon: 'calendar', section: 'booking', title: 'Availability',
    subtitle: 'Manage daily room supply and prices', module: 'booking-availability',
    permissions: ['booking-availability:read', 'booking-availability:manage'],
    render: () => h(AvailabilityAdminPage) }],
};
