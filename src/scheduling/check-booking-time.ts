import type { BookingWindowCode } from './booking-window.js';
import type { OpeningWindow } from './opening-hours.js';
import type { TimeRange } from './time-range.js';

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

export function checkBookingTime(_input: BookingTimeInput): BookingTimeResult {
  throw new Error('not implemented');
}
