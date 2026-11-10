import { checkBookingWindow, type BookingWindowCode } from './booking-window.js';
import { isOnGrid } from './grid.js';
import { fitsOpeningHours, type OpeningWindow } from './opening-hours.js';
import { rangeFromStart, type TimeRange } from './time-range.js';

export type BookingTimeCode = 'START_NOT_ON_GRID' | BookingWindowCode | 'OUTSIDE_OPENING_HOURS';

export interface BookingTimeInput {
  start: Date;
  durationMinutes: number;
  timeZone: string;
  openingHours: readonly OpeningWindow[];
  now: Date;
  stepMinutes: number;
  horizonDays: number;
}

export type BookingTimeResult =
  { ok: true; range: TimeRange } | { ok: false; code: BookingTimeCode };

// All the time rules for one booking request. When a start breaks more than
// one rule the first failing check decides the code, and the order is fixed
// by the SPEC ("Order of checks") so it never depends on how this is written:
// 1. grid (START_NOT_ON_GRID)
// 2. past (START_IN_PAST)
// 3. horizon (BEYOND_BOOKING_HORIZON)
// 4. opening hours (OUTSIDE_OPENING_HOURS)
// An unknown time zone throws from the first check instead of returning a code.
export function checkBookingTime(input: BookingTimeInput): BookingTimeResult {
  if (!isOnGrid(input.start, input.timeZone, input.stepMinutes)) {
    return { ok: false, code: 'START_NOT_ON_GRID' };
  }

  const windowCode = checkBookingWindow(input.start, input.now, input.horizonDays);
  if (windowCode) return { ok: false, code: windowCode };

  const range = rangeFromStart(input.start, input.durationMinutes);
  if (!fitsOpeningHours(range, input.timeZone, input.openingHours)) {
    return { ok: false, code: 'OUTSIDE_OPENING_HOURS' };
  }

  return { ok: true, range };
}
