// Times typed in the grid and forms are read in the PROJECT's zone, not the browser's
// (review item 5/10). These checks also run fine whatever zone the machine is in.
import { describe, expect, test } from '@jest/globals';
import { dayKeyIn, dateTimeIn, fromZonedInput, toZonedInput, whenWithUtc } from './zoneTime';

const cases: [local: string, zone: string, utc: string, note: string][] = [
  ['2026-11-21T21:00', 'America/Chicago', '2026-11-22T03:00:00.000Z', 'CST evening is the next day in UTC'],
  ['2026-07-04T09:30', 'America/Chicago', '2026-07-04T14:30:00.000Z', 'CDT (summer)'],
  ['2026-03-08T03:30', 'America/Chicago', '2026-03-08T08:30:00.000Z', 'just after the spring-forward gap'],
  ['2026-11-01T01:30', 'America/New_York', '2026-11-01T05:30:00.000Z', 'ambiguous fall-back hour: first (EDT) reading'],
  ['2026-11-21T21:00', 'Asia/Kolkata', '2026-11-21T15:30:00.000Z', 'half-hour offset'],
  ['2026-11-21T21:00', 'UTC', '2026-11-21T21:00:00.000Z', 'UTC'],
];

describe('typed times are read in the project zone', () => {
  test.each(cases)('%s in %s → %s (%s)', (local, zone, utc) => {
    expect(fromZonedInput(local, zone)).toBe(utc);
  });

  test.each(cases)('%s in %s shows back the same wall time (%s)', (local, zone, utc) => {
    expect(toZonedInput(utc, zone)).toBe(local);
  });

  test('bad input gives null instead of a wrong time', () => {
    expect(fromZonedInput('', 'America/Chicago')).toBeNull();
    expect(fromZonedInput('21:00', 'America/Chicago')).toBeNull();
  });
});

describe('display', () => {
  test('a Chicago evening deployment stays on its Chicago day', () => {
    const utc = '2026-11-22T03:00:00.000Z';
    expect(dayKeyIn(utc, 'America/Chicago')).toBe('2026-11-21');
    expect(dateTimeIn(utc, 'America/Chicago')).toBe('21 Nov 2026, 21:00');
    expect(whenWithUtc(utc, 'America/Chicago')).toBe('Sat 21 Nov, 21:00 CST (03:00 UTC)');
  });
});
