export type BookingWindowCode = 'START_IN_PAST' | 'BEYOND_BOOKING_HORIZON';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// The start has to be later than now (equal counts as past) and no more than
// horizonDays x 24 hours ahead. Real hours, not local calendar days, so a
// clock change in between doesn't move the limit (AC-16).
export function checkBookingWindow(
  start: Date,
  now: Date,
  horizonDays: number,
): BookingWindowCode | null {
  if (start.getTime() <= now.getTime()) return 'START_IN_PAST';
  if (start.getTime() > now.getTime() + horizonDays * MS_PER_DAY) return 'BEYOND_BOOKING_HORIZON';
  return null;
}
