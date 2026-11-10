// A time range is half open, [start, end). A job ending at 10:00 doesn't
// clash with one starting at 10:00 (ADR 002).
export interface TimeRange {
  start: Date;
  end: Date;
}

export function overlaps(_a: TimeRange, _b: TimeRange): boolean {
  throw new Error('not implemented');
}

export function rangeFromStart(_start: Date, _durationMinutes: number): TimeRange {
  throw new Error('not implemented');
}
