import type {
  BookingAttempt,
  BookingLookup,
  BookingStore,
  NewBooking,
  SlotQuery,
  SlotRead,
} from '../../../src/appointments/booking.store.js';
import type { Appointment, BookingRequest } from '../../../src/appointments/booking.types.js';
import type { Clock } from '../../../src/scheduling/index.js';
import { NORTH_HOURS, NOW } from '../scheduling/fixtures.js';

// A clock the test can move forward, for the loop's time budget.
export class SteppingClock implements Clock {
  private current: number;

  constructor(start: Date = NOW) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

// The request every loop test sends unless it says otherwise: OIL at North on
// Tue 9 March 2027 at 09:00, with the clock at the shared "now".
export const REQUEST: BookingRequest = {
  dealershipId: 'north',
  serviceTypeId: 'oil',
  customerId: 'customer-1',
  vehicleId: 'vehicle-1',
  startTime: new Date('2027-03-09T09:00:00Z'),
  preferredTechnicianId: null,
};

export const RANGE = {
  start: new Date('2027-03-09T09:00:00Z'),
  end: new Date('2027-03-09T10:00:00Z'),
};

// Lookups where every 404 and 422 check passes, so the request reaches the loop.
export function goodLookup(overrides: Partial<BookingLookup> = {}): BookingLookup {
  return {
    dealership: { id: 'north', timeZone: 'Europe/London', openingHours: NORTH_HOURS },
    serviceType: { id: 'oil', durationMinutes: 60, requiredSkillCode: 'OIL_SERVICE' },
    customerFound: true,
    vehicle: { id: 'vehicle-1', customerId: 'customer-1' },
    preferredTechnician: null,
    offersService: true,
    ...overrides,
  };
}

// ['bay-1', 'bay-2', ...]
export function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
}

export function freeRead(overrides: Partial<SlotRead> = {}): SlotRead {
  return {
    vehicleBusy: false,
    preferredTechnicianBusy: false,
    bayIds: ids('bay', 2),
    technicianIds: ids('tech', 2),
    ...overrides,
  };
}

// What the database would hand back for a successful insert.
export function storedFrom(booking: NewBooking, id: string): Appointment {
  return {
    id,
    status: 'confirmed',
    dealershipId: booking.dealershipId,
    serviceTypeId: booking.serviceTypeId,
    customerId: booking.customerId,
    vehicleId: booking.vehicleId,
    serviceBayId: booking.serviceBayId,
    technicianId: booking.technicianId,
    startsAt: booking.range.start,
    endsAt: booking.range.end,
    createdAt: new Date('2027-03-01T09:00:00Z'),
  };
}

// A pg style error with a SQLSTATE in `code`, like the ones Kysely passes on.
export function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`database error ${code}`), { code });
}

// n is 1 for the first read (or insert) of the whole request, 2 for the
// second and so on. An insert script returns the stored row, null for "lost
// the race", or throws.
export interface FakeScript {
  read: (n: number, query: SlotQuery) => SlotRead;
  insert: (n: number, booking: NewBooking) => Appointment | null;
}

// A store with no database. It plays back a script and records every call,
// so a test can check how many attempts the loop made and what it asked for.
export class FakeBookingStore implements BookingStore {
  lookupResult: BookingLookup = goodLookup();
  attempts = 0;
  readonly reads: SlotQuery[] = [];
  readonly inserts: NewBooking[] = [];

  constructor(private readonly script: FakeScript) {}

  lookup(_request: BookingRequest): Promise<BookingLookup> {
    return Promise.resolve(this.lookupResult);
  }

  // Like the real store, whatever the work throws comes out unchanged.
  async runAttempt<T>(work: (attempt: BookingAttempt) => Promise<T>): Promise<T> {
    this.attempts++;
    const attempt: BookingAttempt = {
      readSlot: (query) => {
        this.reads.push(query);
        return call(() => this.script.read(this.reads.length, query));
      },
      tryInsert: (booking) => {
        this.inserts.push(booking);
        return call(() => this.script.insert(this.inserts.length, booking));
      },
    };
    return work(attempt);
  }

  // The (bay, technician) pair of every insert, in order.
  insertedPairs(): [string, string][] {
    return this.inserts.map((b) => [b.serviceBayId, b.technicianId]);
  }
}

// Turns a throw inside a script into a rejected promise, the way an async
// database call fails.
function call<T>(fn: () => T): Promise<T> {
  return Promise.resolve().then(fn);
}
