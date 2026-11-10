import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { OpeningWindow, TimeRange } from '../scheduling/index.js';
import type { BookingConfig } from './booking.config.js';
import type { Appointment, BookingRequest } from './booking.types.js';

// Everything the booking service needs from the database, behind one
// interface. The service only talks to this, so the loop can be unit tested
// with a fake store (AC-25, AC-41) and the Postgres version below is the only
// place that knows about transactions and SQL.

// The facts behind the 404 and 422 checks, read once before the loop. The
// store only reports what it found. The service decides which code wins, in
// the SPEC "Order of checks".
export interface BookingLookup {
  dealership: { id: string; timeZone: string; openingHours: OpeningWindow[] } | null;
  serviceType: { id: string; durationMinutes: number; requiredSkillCode: string } | null;
  customerFound: boolean;
  vehicle: { id: string; customerId: string } | null;
  // null when the request has no preferred technician, and also when the id
  // is unknown. The service knows which one it asked for.
  preferredTechnician: { id: string; dealershipId: string; skillCodes: string[] } | null;
  // The dealership has at least one bay and at least one technician with the
  // required skill, busy or not. False if the dealership or service type is
  // unknown.
  offersService: boolean;
}

// What one attempt asks the classifying read about.
export interface SlotQuery {
  dealershipId: string;
  vehicleId: string;
  skillCode: string;
  range: TimeRange;
  preferredTechnicianId: string | null;
}

// What the classifying read found, as plain facts. The service turns them
// into an answer in the ADR 001 order (vehicle, preferred technician, slot).
// bayIds and technicianIds are the ordered free lists (bays by id,
// technicians by fewest skills then id, A16). The first attempt's list
// lengths give the hard cap.
export interface SlotRead {
  vehicleBusy: boolean;
  preferredTechnicianBusy: boolean;
  bayIds: string[];
  technicianIds: string[];
}

export interface NewBooking {
  dealershipId: string;
  serviceTypeId: string;
  customerId: string;
  vehicleId: string;
  serviceBayId: string;
  technicianId: string;
  range: TimeRange;
}

// One attempt's view of the database. Both calls run inside the attempt's
// transaction.
export interface BookingAttempt {
  readSlot(query: SlotQuery): Promise<SlotRead>;
  // The stored appointment, or null when the insert hit a conflict and
  // inserted nothing (somebody got in first).
  tryInsert(booking: NewBooking): Promise<Appointment | null>;
}

export interface BookingStore {
  lookup(request: BookingRequest): Promise<BookingLookup>;
  // Runs work in one short transaction. Whatever work throws is thrown out of
  // here unchanged, after the rollback.
  runAttempt<T>(work: (attempt: BookingAttempt) => Promise<T>): Promise<T>;
}

// The Postgres store. Not built yet, it waits for findFreeResources from
// step 3.
export class PostgresBookingStore implements BookingStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly config: BookingConfig,
  ) {}

  lookup(_request: BookingRequest): Promise<BookingLookup> {
    return Promise.reject(new Error('not implemented'));
  }

  runAttempt<T>(_work: (attempt: BookingAttempt) => Promise<T>): Promise<T> {
    return Promise.reject(new Error('not implemented'));
  }
}
