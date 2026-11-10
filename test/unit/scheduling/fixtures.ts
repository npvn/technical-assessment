import type { OpeningWindow } from '../../../src/scheduling/index.js';

// The shared setup from docs/SPEC.md.
export const NOW = new Date('2027-03-01T09:00:00Z');

export const LONDON = 'Europe/London';
export const SYDNEY = 'Australia/Sydney';
export const BERLIN = 'Europe/Berlin';

const weekdays = [1, 2, 3, 4, 5];

// North (and South): Monday to Friday 08:00 to 17:30, Saturday 09:00 to 13:00, closed Sunday.
// The times are written the way Postgres `time` returns them.
export const NORTH_HOURS: OpeningWindow[] = [
  ...weekdays.map((d) => ({ isoWeekday: d, opensAt: '08:00:00', closesAt: '17:30:00' })),
  { isoWeekday: 6, opensAt: '09:00:00', closesAt: '13:00:00' },
];

// Harbour: Monday to Saturday 08:00 to 17:00, closed Sunday.
export const HARBOUR_HOURS: OpeningWindow[] = [1, 2, 3, 4, 5, 6].map((d) => ({
  isoWeekday: d,
  opensAt: '08:00:00',
  closesAt: '17:00:00',
}));

// Rhine: Monday to Friday 09:00 to 17:00, closed at weekends.
export const RHINE_HOURS: OpeningWindow[] = weekdays.map((d) => ({
  isoWeekday: d,
  opensAt: '09:00:00',
  closesAt: '17:00:00',
}));

export const OIL_MINUTES = 60;
export const BRAKES_MINUTES = 90;
export const DIAG_MINUTES = 180;

export const STEP_MINUTES = 15;
export const HORIZON_DAYS = 90;

export function at(iso: string): Date {
  return new Date(iso);
}

export function range(startIso: string, endIso: string) {
  return { start: new Date(startIso), end: new Date(endIso) };
}
