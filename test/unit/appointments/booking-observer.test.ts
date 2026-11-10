import type { BookingConfig } from '../../../src/appointments/booking.config.js';
import type { BookingObserver, BookingRecord } from '../../../src/appointments/booking.observer.js';
import { BookingService } from '../../../src/appointments/booking.service.js';
import type { BookingLookup } from '../../../src/appointments/booking.store.js';
import type { BookingRequest } from '../../../src/appointments/booking.types.js';
import { requestHash } from '../../../src/appointments/idempotency.js';
import {
  FakeBookingStore,
  RANGE,
  REQUEST,
  SteppingClock,
  freeRead,
  goodLookup,
  ids,
  pgError,
  storedFrom,
  type FakeScript,
} from './fake-booking-store.js';

// The booking observer (DESIGN section 7). The service calls it once per
// request with the outcome and the loop's own numbers, and the metrics and
// the booking log line are built from that one call. The fake store plays
// the database, and the scripts move the clock so durationMs has a known
// value.

const CONFIG: BookingConfig = {
  lockTimeoutMs: 2_000,
  statementTimeoutMs: 5_000,
  loopBudgetMs: 5_000,
};

class RecordingObserver implements BookingObserver {
  readonly records: BookingRecord[] = [];

  record(record: BookingRecord): void {
    this.records.push(record);
  }
}

// A store whose lookup takes a while, so a test can see that durationMs
// starts at the top of book() and not at the loop.
class SlowLookupStore extends FakeBookingStore {
  constructor(
    script: FakeScript,
    private readonly clock: SteppingClock,
    private readonly lookupMs: number,
  ) {
    super(script);
  }

  override lookup(request: BookingRequest): Promise<BookingLookup> {
    this.clock.advance(this.lookupMs);
    return super.lookup(request);
  }
}

function setup(script: FakeScript, options: { lookupMs?: number } = {}) {
  const clock = new SteppingClock();
  const store = new SlowLookupStore(script, clock, options.lookupMs ?? 0);
  const observer = new RecordingObserver();
  const service = new BookingService(store, clock, CONFIG, observer);
  const book = (request: Partial<BookingRequest> = {}) => service.book({ ...REQUEST, ...request });
  return { store, clock, observer, book };
}

const alwaysLoses = (): null => null;
const books = (n: number, booking: Parameters<FakeScript['insert']>[1]) =>
  storedFrom(booking, `appointment-${n}`);

describe('the observer gets one record per request', () => {
  it('created on the first attempt', async () => {
    const { clock, observer, book } = setup({
      read: () => {
        clock.advance(40);
        return freeRead();
      },
      insert: books,
    });

    expect((await book()).kind).toBe('created');

    expect(observer.records).toEqual([
      {
        dealershipId: 'north',
        serviceTypeId: 'oil',
        outcome: 'created',
        attempts: 1,
        lostRaces: 0,
        durationMs: 40,
      },
    ]);
  });

  it('created after one lost race counts both attempts and the lost race', async () => {
    const { store, clock, observer, book } = setup({
      read: (n) => {
        clock.advance(30);
        return n === 1 ? freeRead() : freeRead({ bayIds: ['bay-2'], technicianIds: ['tech-2'] });
      },
      insert: (n, booking) => (n === 1 ? null : books(n, booking)),
    });

    expect((await book()).kind).toBe('created');

    expect(store.attempts).toBe(2);
    expect(observer.records).toEqual([
      {
        dealershipId: 'north',
        serviceTypeId: 'oil',
        outcome: 'created',
        attempts: 2,
        lostRaces: 1,
        durationMs: 60,
      },
    ]);
  });

  it('a 404 before the loop has 0 attempts, and the ids are the ones the request sent', async () => {
    const { store, observer, book } = setup(
      { read: () => freeRead(), insert: books },
      { lookupMs: 25 },
    );
    store.lookupResult = goodLookup({ dealership: null, offersService: false });

    const result = await book({ dealershipId: 'nowhere', serviceTypeId: 'mystery' });

    expect(result).toEqual({ kind: 'rejected', code: 'DEALERSHIP_NOT_FOUND' });
    expect(observer.records).toEqual([
      {
        dealershipId: 'nowhere',
        serviceTypeId: 'mystery',
        outcome: 'DEALERSHIP_NOT_FOUND',
        attempts: 0,
        lostRaces: 0,
        // The lookup's time counts, durationMs starts at the top of book()
        durationMs: 25,
      },
    ]);
  });

  it('a time rule 422 before the loop has 0 attempts', async () => {
    const { observer, book } = setup({ read: () => freeRead(), insert: books });

    // The shared "now" is 2027-03-01T09:00Z, so this is in the past
    const result = await book({ startTime: new Date('2027-02-26T09:00:00Z') });

    expect(result).toEqual({ kind: 'rejected', code: 'START_IN_PAST' });
    expect(observer.records).toEqual([
      {
        dealershipId: 'north',
        serviceTypeId: 'oil',
        outcome: 'START_IN_PAST',
        attempts: 0,
        lostRaces: 0,
        durationMs: 0,
      },
    ]);
  });

  it('SLOT_UNAVAILABLE after a lost race carries the loop numbers', async () => {
    const { observer, book } = setup({
      read: (n) =>
        n === 1
          ? freeRead({ bayIds: ['bay-1'], technicianIds: ['tech-1'] })
          : freeRead({ bayIds: [], technicianIds: ['tech-1'] }),
      insert: alwaysLoses,
    });

    expect(await book()).toEqual({ kind: 'rejected', code: 'SLOT_UNAVAILABLE' });

    expect(observer.records).toEqual([
      {
        dealershipId: 'north',
        serviceTypeId: 'oil',
        outcome: 'SLOT_UNAVAILABLE',
        attempts: 2,
        lostRaces: 1,
        durationMs: 0,
      },
    ]);
  });

  it('VEHICLE_ALREADY_BOOKED on the first read is 1 attempt and no lost race', async () => {
    const { observer, book } = setup({
      read: () => freeRead({ vehicleBusy: true }),
      insert: books,
    });

    expect(await book()).toEqual({ kind: 'rejected', code: 'VEHICLE_ALREADY_BOOKED' });

    expect(observer.records).toEqual([
      {
        dealershipId: 'north',
        serviceTypeId: 'oil',
        outcome: 'VEHICLE_ALREADY_BOOKED',
        attempts: 1,
        lostRaces: 0,
        durationMs: 0,
      },
    ]);
  });

  it('replayed at the first key lookup has 0 attempts', async () => {
    const { store, observer, book } = setup({ read: () => freeRead(), insert: books });
    const keyed: BookingRequest = { ...REQUEST, idempotencyKey: 'key-1' };
    store.lookupResult = goodLookup({
      keyed: {
        appointment: storedFrom(
          {
            dealershipId: 'north',
            serviceTypeId: 'oil',
            customerId: 'customer-1',
            vehicleId: 'vehicle-1',
            serviceBayId: 'bay-1',
            technicianId: 'tech-1',
            range: RANGE,
          },
          'appointment-original',
        ),
        requestHash: requestHash(keyed),
      },
    });

    expect((await book(keyed)).kind).toBe('replayed');

    expect(observer.records).toEqual([
      {
        dealershipId: 'north',
        serviceTypeId: 'oil',
        outcome: 'replayed',
        attempts: 0,
        lostRaces: 0,
        durationMs: 0,
      },
    ]);
  });
});

describe('contended requests carry the reason', () => {
  it('attempt_cap after B + T + 2 lost races', async () => {
    // B = 2 and T = 3 at the first read, so the cap is 7
    const { observer, book } = setup({
      read: () => freeRead({ bayIds: ids('bay', 2), technicianIds: ids('tech', 3) }),
      insert: alwaysLoses,
    });

    expect(await book()).toEqual({ kind: 'contended', reason: 'attempt_cap' });

    expect(observer.records).toEqual([
      {
        dealershipId: 'north',
        serviceTypeId: 'oil',
        outcome: 'BOOKING_CONTENDED',
        reason: 'attempt_cap',
        attempts: 7,
        lostRaces: 7,
        durationMs: 0,
      },
    ]);
  });

  it('time_budget, with the time the loop spent', async () => {
    // Each read takes 3 s. After the second one the 5 s budget is gone.
    const { clock, observer, book } = setup({
      read: () => {
        clock.advance(3_000);
        return freeRead({ bayIds: ids('bay', 5), technicianIds: ids('tech', 5) });
      },
      insert: alwaysLoses,
    });

    expect(await book()).toEqual({ kind: 'contended', reason: 'time_budget' });

    expect(observer.records).toEqual([
      {
        dealershipId: 'north',
        serviceTypeId: 'oil',
        outcome: 'BOOKING_CONTENDED',
        reason: 'time_budget',
        attempts: 2,
        lostRaces: 2,
        durationMs: 6_000,
      },
    ]);
  });

  it('db_retries_exhausted counts the failed transactions as attempts, not as lost races', async () => {
    const { store, observer, book } = setup({
      read: () => freeRead(),
      insert: () => {
        throw pgError('40P01');
      },
    });

    expect(await book()).toEqual({ kind: 'contended', reason: 'db_retries_exhausted' });

    // 3 retries allowed, the 4th error gives up
    expect(store.attempts).toBe(4);
    expect(observer.records).toEqual([
      {
        dealershipId: 'north',
        serviceTypeId: 'oil',
        outcome: 'BOOKING_CONTENDED',
        reason: 'db_retries_exhausted',
        attempts: 4,
        lostRaces: 0,
        durationMs: 0,
      },
    ]);
  });

  it('statement_timeout on the first attempt', async () => {
    const { observer, book } = setup({
      read: () => {
        throw pgError('57014');
      },
      insert: books,
    });

    expect(await book()).toEqual({ kind: 'contended', reason: 'statement_timeout' });

    expect(observer.records).toEqual([
      {
        dealershipId: 'north',
        serviceTypeId: 'oil',
        outcome: 'BOOKING_CONTENDED',
        reason: 'statement_timeout',
        attempts: 1,
        lostRaces: 0,
        durationMs: 0,
      },
    ]);
  });

  it('a lost race, then a deadlock, then a booking is 3 attempts and 1 lost race', async () => {
    const { observer, book } = setup({
      read: () => freeRead(),
      insert: (n, booking) => {
        if (n === 1) return null;
        if (n === 2) throw pgError('40P01');
        return books(n, booking);
      },
    });

    expect((await book()).kind).toBe('created');

    expect(observer.records).toEqual([
      {
        dealershipId: 'north',
        serviceTypeId: 'oil',
        outcome: 'created',
        attempts: 3,
        lostRaces: 1,
        durationMs: 0,
      },
    ]);
  });
});

describe('when something goes wrong', () => {
  it('an unexpected error is still recorded once as INTERNAL_ERROR, then thrown on unchanged', async () => {
    const boom = new Error('connection terminated unexpectedly');
    const { observer, book } = setup({
      read: () => freeRead(),
      insert: () => {
        throw boom;
      },
    });

    await expect(book()).rejects.toBe(boom);

    expect(observer.records).toEqual([
      {
        dealershipId: 'north',
        serviceTypeId: 'oil',
        outcome: 'INTERNAL_ERROR',
        attempts: 1,
        lostRaces: 0,
        durationMs: 0,
      },
    ]);
  });

  // The database not being there is not a bug, so it gets its own outcome
  // and the metrics can tell an outage from a 500.
  it('the database going away during the lookups is recorded as SERVICE_UNAVAILABLE, then thrown on unchanged', async () => {
    const gone = pgError('57P01');
    const { store, observer, book } = setup({ read: () => freeRead(), insert: books });
    store.lookup = () => Promise.reject(gone);

    await expect(book()).rejects.toBe(gone);

    expect(observer.records).toEqual([
      {
        dealershipId: 'north',
        serviceTypeId: 'oil',
        outcome: 'SERVICE_UNAVAILABLE',
        attempts: 0,
        lostRaces: 0,
        durationMs: 0,
      },
    ]);
  });

  it('a refused connection inside an attempt is SERVICE_UNAVAILABLE too', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:5432'), {
      code: 'ECONNREFUSED',
    });
    const { observer, book } = setup({
      read: () => {
        throw refused;
      },
      insert: books,
    });

    await expect(book()).rejects.toBe(refused);

    expect(observer.records).toEqual([
      expect.objectContaining({ outcome: 'SERVICE_UNAVAILABLE', attempts: 1, lostRaces: 0 }),
    ]);
  });

  it('an observer that throws does not change the answer', async () => {
    // The booking is already committed by the time the observer runs. A
    // broken metric must not turn it into a 500 the client would retry.
    const clock = new SteppingClock();
    const store = new FakeBookingStore({ read: () => freeRead(), insert: books });
    let calls = 0;
    const broken: BookingObserver = {
      record: () => {
        calls++;
        throw new Error('metrics are broken');
      },
    };
    const service = new BookingService(store, clock, CONFIG, broken);

    const result = await service.book(REQUEST);

    expect(result).toEqual({
      kind: 'created',
      appointment: expect.objectContaining({ id: 'appointment-1' }),
    });
    expect(calls).toBe(1);
  });
});
