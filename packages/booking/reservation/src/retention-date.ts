import { isCanonicalLocalDate } from '@storeweave/booking-availability';

const DAY_MS = 86_400_000;

export type ReservationRetentionEligibility =
  | { readonly kind: 'eligible'; readonly eligibleOnLocalDate: string }
  | { readonly kind: 'ineligible' }
  | { readonly kind: 'invalid' };

function civilDateOrdinal(value: string): number | undefined {
  if (!isCanonicalLocalDate(value)) return undefined;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime() / DAY_MS;
}

function localDateAt(instant: Date, timeZone: string): string | undefined {
  if (!Number.isFinite(instant.getTime())) return undefined;
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const localDate = `${String(fields.year).padStart(4, '0')}-${fields.month}-${fields.day}`;
    return isCanonicalLocalDate(localDate) ? localDate : undefined;
  } catch {
    return undefined;
  }
}

function dateFromOrdinal(ordinal: number): string | undefined {
  const date = new Date(ordinal * DAY_MS);
  if (!Number.isFinite(date.getTime())) return undefined;
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) return undefined;
  const value = `${String(year).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  return isCanonicalLocalDate(value) ? value : undefined;
}

export function evaluateReservationRetentionEligibility(input: {
  checkOutLocalDate: string;
  propertyTimeZone: string;
  reservationPiiRetentionDays: number;
  now: Date;
}): ReservationRetentionEligibility {
  if (!Number.isSafeInteger(input.reservationPiiRetentionDays) || input.reservationPiiRetentionDays < 1) {
    return { kind: 'invalid' };
  }
  const checkOutOrdinal = civilDateOrdinal(input.checkOutLocalDate);
  const today = localDateAt(input.now, input.propertyTimeZone);
  const todayOrdinal = today ? civilDateOrdinal(today) : undefined;
  if (checkOutOrdinal === undefined || todayOrdinal === undefined) return { kind: 'invalid' };

  const deadlineOrdinal = BigInt(checkOutOrdinal) + BigInt(input.reservationPiiRetentionDays);
  if (BigInt(todayOrdinal) < deadlineOrdinal) return { kind: 'ineligible' };

  const eligibleOnLocalDate = dateFromOrdinal(Number(deadlineOrdinal));
  return eligibleOnLocalDate ? { kind: 'eligible', eligibleOnLocalDate } : { kind: 'invalid' };
}
