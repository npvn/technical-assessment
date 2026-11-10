export type BookingWindowCode = 'START_IN_PAST' | 'BEYOND_BOOKING_HORIZON';

export function checkBookingWindow(
  _start: Date,
  _now: Date,
  _horizonDays: number,
): BookingWindowCode | null {
  throw new Error('not implemented');
}
