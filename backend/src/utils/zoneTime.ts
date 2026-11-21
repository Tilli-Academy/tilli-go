/** Zone used when a change request has no project yet (current cutovers run in US Central). */
export const DEFAULT_TIME_ZONE = 'America/Chicago';

/** "YYYY-MM-DD" — the calendar day of that moment in the given zone. */
export function dayKeyIn(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
