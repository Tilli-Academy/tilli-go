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
