export interface WeeklyStartTimes {
  /** Sunday is 0. */
  readonly weekday: number;
  readonly startTimes: readonly string[];
}

export interface DateStartTimesOverride {
  readonly date: string;
  /** An empty list closes this start date. */
  readonly startTimes: readonly string[];
}

export interface BookingWindowLimits {
  readonly minAdvanceMinutes?: number;
  readonly maxAdvanceDays?: number;
}

function parseDate(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000-')) {
    throw new RangeError(`Invalid local date: ${date}`);
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new RangeError(`Invalid local date: ${date}`);
  }
  return parsed;
}

function parseTime(time: string): void {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new RangeError(`Invalid local time: ${time}`);
  }
}

function localFormatter(timezone: string): Intl.DateTimeFormat {
  if (typeof timezone !== 'string' || !/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(timezone)) {
    throw new RangeError(`Invalid IANA timezone: ${timezone}`);
  }
  try {
    return new Intl.DateTimeFormat('en-US-u-ca-gregory', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  } catch {
    throw new RangeError(`Invalid IANA timezone: ${timezone}`);
  }
}

function localParts(formatter: Intl.DateTimeFormat, at: Date): number[] {
  const parts = formatter.formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return [value('year'), value('month'), value('day'), value('hour'), value('minute'), value('second')];
}

function utcMillis(parts: number[]): number {
  const [year, month, day, hour, minute, second] = parts;
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour, minute, second, 0);
  return at.getTime();
}

/** Resolve a local start only when exactly one UTC instant has that wall-clock value. */
export function resolveLocalStart(date: string, time: string, timezone: string): Date | undefined {
  parseDate(date);
  parseTime(time);
  const formatter = localFormatter(timezone);
  const wallClock = new Date(`${date}T${time}:00.000Z`).getTime();
  const expected = [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)),
    Number(time.slice(0, 2)), Number(time.slice(3, 5)), 0];
  const offsets = new Set<number>();
  // Every real IANA offset is within 24 hours of UTC. Sampling across the range
  // catches both sides of a DST transition without relying on the host timezone.
  for (let hour = -24; hour <= 24; hour += 1) {
    const sample = new Date(wallClock + hour * 60 * 60_000);
    offsets.add(utcMillis(localParts(formatter, sample)) - sample.getTime());
  }
  const matches: Date[] = [];
  for (const offset of offsets) {
    const at = new Date(wallClock - offset);
    if (localParts(formatter, at).every((value, index) => value === expected[index])) matches.push(at);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function validatedTimes(times: readonly string[]): string[] {
  if (!Array.isArray(times)) throw new RangeError('Start times must be an array');
  for (const time of times) parseTime(time);
  if (new Set(times).size !== times.length) throw new RangeError('Duplicate start time');
  return [...times].sort();
}

/** Date overrides replace that start date's weekly times, including when empty. */
export function offeredStartTimes(
  date: string,
  weekly: readonly WeeklyStartTimes[],
  overrides: readonly DateStartTimesOverride[],
): string[] {
  const parsedDate = parseDate(date);
  if (!Array.isArray(weekly) || !Array.isArray(overrides)) throw new RangeError('Invalid schedule');
  const weekdays = new Set<number>();
  for (const entry of weekly) {
    if (!Number.isInteger(entry.weekday) || entry.weekday < 0 || entry.weekday > 6 || weekdays.has(entry.weekday)) {
      throw new RangeError('Invalid or duplicate weekday');
    }
    weekdays.add(entry.weekday);
    validatedTimes(entry.startTimes);
  }
  const dates = new Set<string>();
  for (const entry of overrides) {
    parseDate(entry.date);
    if (dates.has(entry.date)) throw new RangeError('Duplicate override date');
    dates.add(entry.date);
    validatedTimes(entry.startTimes);
  }
  const override = overrides.find((entry) => entry.date === date);
  const times = override?.startTimes ?? weekly.find((entry) => entry.weekday === parsedDate.getUTCDay())?.startTimes ?? [];
  return validatedTimes(times);
}

/** Both booking-window endpoints are inclusive and measured in UTC elapsed time. */
export function isWithinBookingWindow(
  startAt: Date,
  now: Date,
  limits: BookingWindowLimits = {},
): boolean {
  if (!(startAt instanceof Date) || !Number.isFinite(startAt.getTime()) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new RangeError('Booking-window instants must be valid dates');
  }
  const minAdvanceMinutes = limits.minAdvanceMinutes ?? 60;
  const maxAdvanceDays = limits.maxAdvanceDays ?? 30;
  if (!Number.isSafeInteger(minAdvanceMinutes) || minAdvanceMinutes <= 0 ||
      !Number.isSafeInteger(maxAdvanceDays) || maxAdvanceDays <= 0) {
    throw new RangeError('Booking-window bounds must be positive integers');
  }
  const advance = startAt.getTime() - now.getTime();
  return advance >= minAdvanceMinutes * 60_000 && advance <= maxAdvanceDays * 24 * 60 * 60_000;
}
