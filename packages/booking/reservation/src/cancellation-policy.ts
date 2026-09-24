import { bookingQuoteSchema, isCanonicalLocalDate } from '@storeweave/booking-availability';

const MINUTE_MS = 60_000;

export type ReservationCancellationEligibility =
  | { readonly kind: 'eligible'; readonly deadline: Date }
  | { readonly kind: 'ineligible'; readonly deadline: Date }
  | { readonly kind: 'invalid' };

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

function localPartsAt(instant: Date, timeZone: string): LocalParts | undefined {
  if (!Number.isFinite(instant.getTime())) return undefined;
  try {
    const fields = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(instant).map(part => [part.type, part.value]));
    const result = { year: Number(fields.year), month: Number(fields.month), day: Number(fields.day), hour: Number(fields.hour), minute: Number(fields.minute) };
    return Object.values(result).every(Number.isSafeInteger) ? result : undefined;
  } catch {
    return undefined;
  }
}

function offsetMinutesAt(instant: Date, timeZone: string): number | undefined {
  try {
    const value = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(instant).find(part => part.type === 'timeZoneName')?.value;
    if (value === 'GMT') return 0;
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(value ?? '');
    if (!match) return undefined;
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === '+' ? minutes : -minutes;
  } catch {
    return undefined;
  }
}

/** Resolve a frozen local check-in civil time only when it identifies one IANA instant. */
function localCheckInInstant(checkInLocalDate: string, checkInTime: string, timeZone: string): Date | undefined {
  if (!isCanonicalLocalDate(checkInLocalDate) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(checkInTime)) return undefined;
  const [year, month, day] = checkInLocalDate.split('-').map(Number);
  const [hour, minute] = checkInTime.split(':').map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  if (!Number.isFinite(naive)) return undefined;
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 1) {
    const offset = offsetMinutesAt(new Date(naive + hours * 60 * MINUTE_MS), timeZone);
    if (offset !== undefined) offsets.add(offset);
  }
  const target: LocalParts = { year, month, day, hour, minute };
  const matches = [...offsets].map(offset => new Date(naive - offset * MINUTE_MS))
    .filter(candidate => {
      const actual = localPartsAt(candidate, timeZone);
      return actual !== undefined && Object.entries(target).every(([key, value]) => actual[key as keyof LocalParts] === value);
    });
  return matches.length === 1 ? matches[0] : undefined;
}

export function evaluateReservationCancellationEligibility(input: {
  checkInLocalDate: string;
  cancellationPolicy: unknown;
  now: Date;
}): ReservationCancellationEligibility {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) return { kind: 'invalid' };
  const policy = bookingQuoteSchema.shape.cancellationPolicy.safeParse(input.cancellationPolicy);
  if (!policy.success) return { kind: 'invalid' };
  const checkIn = localCheckInInstant(input.checkInLocalDate, policy.data.checkInTime, policy.data.propertyTimeZone);
  if (!checkIn) return { kind: 'invalid' };
  const deadline = new Date(checkIn.getTime() - policy.data.freeCancellationHoursBeforeCheckIn * 60 * 60 * 1000);
  if (!Number.isFinite(deadline.getTime())) return { kind: 'invalid' };
  return input.now.getTime() < deadline.getTime() ? { kind: 'eligible', deadline } : { kind: 'ineligible', deadline };
}
