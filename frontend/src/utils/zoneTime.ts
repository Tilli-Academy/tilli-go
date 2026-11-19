// Times are shown in the project's timezone (not the browser's), with UTC alongside
// where there's room. Same wording as the start-time alert email.

type When = string | number | Date;
const toMs = (v: When) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : new Date(v).getTime());

/** Short zone name at that moment: CST / CDT / IST / UTC (falls back to GMT-6 style). */
export function zoneLabel(tz: string, at: When = Date.now()): string {
  if (tz === 'Asia/Kolkata') return 'IST';
  if (tz === 'UTC' || tz === 'Etc/UTC') return 'UTC';
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(new Date(toMs(at)))
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? tz;
}

/** "21:00" in that zone */
export const timeIn = (v: When, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(toMs(v)));

/** "Sat 17 Oct" in that zone */
export const dayIn = (v: When, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(toMs(v)));

/** "2026-10-17" — the calendar day in that zone */
export const dayKeyIn = (v: When, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(toMs(v)));

/** How far the zone's wall clock is ahead of UTC at that moment, in ms. */
export function zoneOffsetMs(v: When, tz: string): number {
  const ms = toMs(v);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  const wall = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The moment a "YYYY-MM-DD" day starts in that zone. */
export function startOfDayIn(dayKey: string, tz: string): number {
  const [y, m, d] = dayKey.split('-').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!);
  const first = guess - zoneOffsetMs(guess, tz);
  return guess - zoneOffsetMs(first, tz);
}

/** "Sat 17 Oct, 21:00 CST (03:00 UTC)" */
export function whenWithUtc(v: When | null | undefined, tz: string, empty = '—'): string {
  if (v === null || v === undefined || v === '') return empty;
  const local = `${dayIn(v, tz)}, ${timeIn(v, tz)} ${zoneLabel(tz, v)}`;
  return tz === 'UTC' || tz === 'Etc/UTC' ? local : `${local} (${timeIn(v, 'UTC')} UTC)`;
}

/** "2026-11-21T21:00" — the wall-clock time in that zone, for <input type="datetime-local">. */
export function toZonedInput(v: When | null | undefined, tz: string): string {
  if (v === null || v === undefined || v === '') return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(toMs(v))).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/**
 * The moment a wall-clock time ("2026-11-21T21:00") happens in that zone, as ISO (UTC).
 * Times typed into the grid or forms are read in the project's zone, not the browser's.
 */
export function fromZonedInput(local: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return null;
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  // Two passes settle the zone offset, also around daylight-saving changes.
  const first = wall - zoneOffsetMs(wall, tz);
  return new Date(wall - zoneOffsetMs(first, tz)).toISOString();
}

/** "21 Nov 2026, 21:00" in that zone (no zone label; headers carry it). */
export const dateTimeIn = (v: When, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(toMs(v)));

/** Zone used when there is no project yet (current cutovers run in US Central). */
export const DEFAULT_TIME_ZONE = 'America/Chicago';

/**
 * Season-neutral zone name for labels that cover many dates (column headers, pickers):
 * "CT" rather than CST/CDT, which would be wrong for half the year. Single values keep
 * the exact abbreviation (zoneLabel).
 */
export function zoneName(tz: string): string {
  if (tz === 'Asia/Kolkata') return 'IST';
  if (tz === 'UTC' || tz === 'Etc/UTC') return 'UTC';
  try {
    const generic = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortGeneric' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    if (generic && generic.length <= 4) return generic;
  } catch {
    /* older browsers: fall through */
  }
  return `${tz.split('/').pop()!.replace(/_/g, ' ')} time`;
}
