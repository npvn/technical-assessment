import { DateTime } from 'luxon';

// A time range is half open, [start, end). A job ending at 10:00 doesn't
// clash with one starting at 10:00 (ADR 002).
export interface TimeRange {
  start: Date;
  end: Date;
}

// Strict < on both sides, so touching ranges don't overlap.
export function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

// The end is the start plus real elapsed minutes on the instant, worked out
// in UTC so a clock change in the dealership's zone can't shift it.
export function rangeFromStart(start: Date, durationMinutes: number): TimeRange {
  const startUtc = DateTime.fromJSDate(start, { zone: 'utc' });
  return {
    start: startUtc.toJSDate(),
    end: startUtc.plus({ minutes: durationMinutes }).toJSDate(),
  };
}
