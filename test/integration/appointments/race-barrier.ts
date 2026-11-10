import type { Kysely } from 'kysely';
import {
  DEFAULT_BOOKING_CONFIG,
  type BookingConfig,
} from '../../../src/appointments/booking.config.js';
import { BookingService } from '../../../src/appointments/booking.service.js';
import {
  PostgresBookingStore,
  type BookingAttempt,
  type BookingLookup,
  type BookingStore,
} from '../../../src/appointments/booking.store.js';
import type { BookingRequest } from '../../../src/appointments/booking.types.js';
import type { Database } from '../../../src/db/types.js';
import { FixedClock } from '../../../src/scheduling/index.js';
import { NOW } from './world.js';

// A test-only way to make a race really happen. Without it, N parallel
// requests can get spread out in time (a cold pool opens its connections one
// by one, and the lookups run before the loop), so the first booking commits
// before the others even read and they honestly see "no slot". That way the
// race never opens and the test proves nothing about the constraints.
//
// The barrier holds the first N slot reads until all N have happened, then
// lets them all go at once. So every request has read "free" before anybody
// inserts, and only the exclusion constraints can stop a double booking.

const BARRIER_TIMEOUT_MS = 10_000;

export class RaceBarrier {
  private arrived = 0;
  private open = false;
  private timer: NodeJS.Timeout | undefined;
  private release!: () => void;
  private fail!: (error: Error) => void;
  private readonly gate: Promise<void>;

  constructor(
    private readonly parties: number,
    private readonly timeoutMs = BARRIER_TIMEOUT_MS,
  ) {
    this.gate = new Promise<void>((resolve, reject) => {
      this.release = resolve;
      this.fail = reject;
    });
    // Nobody may be waiting yet when it fails, and every waiter gets the
    // error through its own await anyway.
    this.gate.catch(() => {});
  }

  // Called after a read. The first N calls wait for each other, anything
  // after the barrier opened goes straight through. Counting calls is the
  // same as counting requests here: a request held at the barrier can't
  // read again, so the first N arrivals are N different requests. That
  // matters because the losers read again after their insert came back
  // empty, and they must not wait for requests that are already done.
  async arrive(): Promise<void> {
    if (this.open || this.arrived >= this.parties) return;
    this.arrived++;
    if (this.arrived === 1) {
      // Started on the first arrival, so the setup before the race doesn't
      // count. Plain Error with no code, so the booking loop doesn't take it
      // for a database error it could retry.
      this.timer = setTimeout(() => {
        this.fail(
          new Error(
            `race barrier: only ${this.arrived} of ${this.parties} requests reached their first read within ${this.timeoutMs} ms`,
          ),
        );
      }, this.timeoutMs);
    }
    if (this.arrived === this.parties) {
      clearTimeout(this.timer);
      this.open = true;
      this.release();
    }
    await this.gate;
  }
}

// Wraps the real Postgres store. Everything still runs in the real
// transaction, the barrier only adds a wait after the first reads. While they
// wait all N requests hold an open transaction and a pool connection, so the
// pool has to be bigger than N.
export class RaceBarrierStore implements BookingStore {
  constructor(
    private readonly inner: BookingStore,
    private readonly barrier: RaceBarrier,
  ) {}

  lookup(request: BookingRequest): Promise<BookingLookup> {
    return this.inner.lookup(request);
  }

  runAttempt<T>(work: (attempt: BookingAttempt) => Promise<T>): Promise<T> {
    return this.inner.runAttempt((attempt) =>
      work({
        readSlot: async (query) => {
          const read = await attempt.readSlot(query);
          await this.barrier.arrive();
          return read;
        },
        tryInsert: (booking) => attempt.tryInsert(booking),
      }),
    );
  }
}

// A booking service for one race of `parties` parallel requests. Each race
// needs its own, because a barrier opens once and stays open.
export function racingBookingService(
  db: Kysely<Database>,
  parties: number,
  config: Partial<BookingConfig> = {},
): BookingService {
  const full = { ...DEFAULT_BOOKING_CONFIG, ...config };
  const store = new RaceBarrierStore(new PostgresBookingStore(db, full), new RaceBarrier(parties));
  return new BookingService(store, new FixedClock(NOW), full);
}
