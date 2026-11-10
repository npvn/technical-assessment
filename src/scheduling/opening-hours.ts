import type { TimeRange } from './time-range.js';

// One opening window for one local weekday (1 is Monday, 7 is Sunday).
// opensAt and closesAt are local wall times as Postgres `time` returns them,
// like '08:00:00'. '08:00' is accepted too.
export interface OpeningWindow {
  isoWeekday: number;
  opensAt: string;
  closesAt: string;
}

export function fitsOpeningHours(
  _range: TimeRange,
  _timeZone: string,
  _windows: readonly OpeningWindow[],
): boolean {
  throw new Error('not implemented');
}
