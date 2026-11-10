import type { DateTime } from 'luxon';
import type { TimeRange } from './time-range.js';
import { toZone } from './zone.js';

// One opening window for one local weekday (1 is Monday, 7 is Sunday).
// opensAt and closesAt are local wall times as Postgres `time` returns them,
// like '08:00:00'. '08:00' is accepted too.
export interface OpeningWindow {
  isoWeekday: number;
  opensAt: string;
  closesAt: string;
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

// Turns '08:00:00' or '08:00' into milliseconds after local midnight.
function parseWallTime(value: string): number {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) {
    throw new Error(`Bad opening time "${value}", expected HH:MM or HH:MM:SS`);
  }
  const [, hours, minutes, seconds] = match;
  return (
    Number(hours) * MS_PER_HOUR +
    Number(minutes) * MS_PER_MINUTE +
    Number(seconds ?? 0) * MS_PER_SECOND
  );
}

// Wall clock time of day from the local fields, not time elapsed since
// midnight. On a clock change day those two differ by an hour.
function wallTimeOf(local: DateTime): number {
  return (
    local.hour * MS_PER_HOUR +
    local.minute * MS_PER_MINUTE +
    local.second * MS_PER_SECOND +
    local.millisecond
  );
}

// The range has to start and end inside the window for the start's local
// weekday, on the same local date. Ending exactly at closing is fine. No
// window for that weekday means the dealership is closed.
export function fitsOpeningHours(
  range: TimeRange,
  timeZone: string,
  windows: readonly OpeningWindow[],
): boolean {
  const start = toZone(range.start, timeZone);
  const end = toZone(range.end, timeZone);

  const window = windows.find((w) => w.isoWeekday === start.weekday);
  if (!window) return false;
  if (!start.hasSame(end, 'day')) return false;

  return (
    wallTimeOf(start) >= parseWallTime(window.opensAt) &&
    wallTimeOf(end) <= parseWallTime(window.closesAt)
  );
}
