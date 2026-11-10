import type { BookingErrorCode, ContendedReason } from './booking.types.js';

// How the booking numbers get out of the loop (DESIGN section 7). The service
// calls record once per booking request, and the metrics and the booking log
// line both hang off it. Only ids go in here, never a name, email or VIN.

// created, replayed, or the error code the client gets. A 503 is
// BOOKING_CONTENDED, the same code the API answers with, and INTERNAL_ERROR
// is a bug or an outage that came out of the service as a throw.
export type BookingOutcome =
  'created' | 'replayed' | BookingErrorCode | 'BOOKING_CONTENDED' | 'INTERNAL_ERROR';

export interface BookingRecord {
  dealershipId: string;
  serviceTypeId: string;
  outcome: BookingOutcome;
  // Only on BOOKING_CONTENDED
  reason?: ContendedReason;
  // Transactions the loop started, including ones that failed with a
  // database error. 0 when the request was answered before the loop.
  attempts: number;
  // Inserts that came back with zero rows
  lostRaces: number;
  // From the start of book() to the answer, on the injected clock
  durationMs: number;
}

export interface BookingObserver {
  record(record: BookingRecord): void;
}

// The default when nothing is wired up, so the loop tests can build the
// service with three arguments like before.
export const noopBookingObserver: BookingObserver = {
  record: () => {},
};
