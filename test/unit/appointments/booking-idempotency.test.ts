import type { BookingConfig } from '../../../src/appointments/booking.config.js';
import { BookingService } from '../../../src/appointments/booking.service.js';
import type { KeyedAppointment } from '../../../src/appointments/booking.store.js';
import type { Appointment, BookingRequest } from '../../../src/appointments/booking.types.js';
import { requestHash } from '../../../src/appointments/idempotency.js';
import {
  FakeBookingStore,
  RANGE,
  REQUEST,
  SteppingClock,
  freeRead,
  goodLookup,
  storedFrom,
  type FakeScript,
} from './fake-booking-store.js';

// Where the idempotency key sits in the booking loop (ADR 001 decisions 3
// and 4), with the fake store. Two places look the key up:
// - once at the very start, before the 404s, 422s and time rules, so a
//   replay works even after its start time has passed (AC-42)
// - again in every attempt's read, before the vehicle check, because a twin
//   with the same key may have committed in between (AC-30, AC-45)
// The real Postgres races are in test/integration/appointments.

const CONFIG: BookingConfig = {
  lockTimeoutMs: 2_000,
  statementTimeoutMs: 5_000,
  loopBudgetMs: 5_000,
};

const KEY = 'key-1';
const KEYED_REQUEST: BookingRequest = { ...REQUEST, idempotencyKey: KEY };

// The appointment a twin (or an earlier try) booked with KEY.
const ORIGINAL: Appointment = {
  id: 'appointment-original',
  status: 'confirmed',
  dealershipId: REQUEST.dealershipId,
  serviceTypeId: REQUEST.serviceTypeId,
  customerId: REQUEST.customerId,
  vehicleId: REQUEST.vehicleId,
  serviceBayId: 'bay-1',
  technicianId: 'tech-1',
  startsAt: RANGE.start,
  endsAt: RANGE.end,
  createdAt: new Date('2027-03-01T08:00:00Z'),
};

// Booked with this very request, so asking again is a replay.
const sameRequest = (request: BookingRequest = KEYED_REQUEST): KeyedAppointment => ({
  appointment: ORIGINAL,
  requestHash: requestHash(request),
});

// Booked with KEY but for something else, say another start time.
const otherRequest = (): KeyedAppointment => ({
  appointment: { ...ORIGINAL, startsAt: new Date('2027-03-09T11:00:00Z') },
  requestHash: requestHash({ ...REQUEST, startTime: new Date('2027-03-09T11:00:00Z') }),
});

const bookable: FakeScript = {
  read: () => freeRead(),
  insert: (_n, booking) => storedFrom(booking, 'appointment-new'),
};

function setup(script: FakeScript = bookable, clock = new SteppingClock()) {
  const store = new FakeBookingStore(script);
  const service = new BookingService(store, clock, CONFIG);
  const book = (request: Partial<BookingRequest> = {}) =>
    service.book({ ...KEYED_REQUEST, ...request });
  return { store, service, clock, book };
}

describe('the key check at the start', () => {
  it('AC-26 a key booked with the same request is replayed, with no attempt at all', async () => {
    const { store, book } = setup();
    store.lookupResult = goodLookup({ keyed: sameRequest() });

    const result = await book();

    expect(result).toEqual({ kind: 'replayed', appointment: ORIGINAL });
    expect(store.attempts).toBe(0);
    expect(store.inserts).toHaveLength(0);
  });

  it('AC-27 a key booked with a different request is IDEMPOTENCY_KEY_REUSED, with no attempt', async () => {
    const { store, book } = setup();
    store.lookupResult = goodLookup({ keyed: otherRequest() });

    const result = await book();

    expect(result).toEqual({ kind: 'rejected', code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(store.attempts).toBe(0);
  });

  it('AC-42 the replay wins over the 404s and the 422s', async () => {
    const { store, book } = setup();
    // Several things wrong at once: unknown dealership, unknown service
    // type, and a preferred technician who isn't found.
    const asked = { ...KEYED_REQUEST, preferredTechnicianId: 'tech-9' };
    store.lookupResult = goodLookup({
      dealership: null,
      serviceType: null,
      preferredTechnician: null,
      offersService: false,
      keyed: sameRequest(asked),
    });

    const result = await book(asked);

    expect(result).toMatchObject({ kind: 'replayed', appointment: { id: ORIGINAL.id } });
  });

  it('AC-42 the replay still works after its start time has passed (not START_IN_PAST)', async () => {
    const clock = new SteppingClock(new Date('2027-03-09T12:00:00Z'));
    const { store, book } = setup(bookable, clock);
    store.lookupResult = goodLookup({ keyed: sameRequest() });

    const result = await book();

    expect(result).toEqual({ kind: 'replayed', appointment: ORIGINAL });
  });

  it('AC-42 a reused key wins over the 404s too', async () => {
    const { store, book } = setup();
    store.lookupResult = goodLookup({ dealership: null, keyed: otherRequest() });

    const result = await book();

    expect(result).toEqual({ kind: 'rejected', code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('nothing booked with the key yet: books, and the read and the insert both carry the key', async () => {
    const { store, book } = setup();
    store.lookupResult = goodLookup({ keyed: null });

    const result = await book();

    expect(result).toMatchObject({ kind: 'created', appointment: { id: 'appointment-new' } });
    // The read looks the key up again for this customer, and the insert
    // stores it with the hash, so a twin is stopped by the unique index.
    expect(store.reads[0]?.idempotency).toEqual({ customerId: REQUEST.customerId, key: KEY });
    expect(store.inserts[0]?.idempotency).toEqual({
      key: KEY,
      requestHash: requestHash(KEYED_REQUEST),
    });
    expect(store.inserts[0]?.idempotency?.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the key check inside an attempt', () => {
  it('AC-30 a twin with the same request beat us: the next read replays it, not VEHICLE_ALREADY_BOOKED', async () => {
    const { store, book } = setup({
      // First read: all free. Then the insert loses to the twin. The second
      // read sees the twin's booking on our vehicle, and the key on it.
      read: (n) => (n === 1 ? freeRead() : freeRead({ vehicleBusy: true, keyed: sameRequest() })),
      insert: () => null,
    });

    const result = await book();

    expect(result).toEqual({ kind: 'replayed', appointment: ORIGINAL });
    expect(store.attempts).toBe(2);
    expect(store.inserts).toHaveLength(1);
  });

  it('AC-45 a twin with a different request beat us: IDEMPOTENCY_KEY_REUSED, never its booking', async () => {
    const { store, book } = setup({
      read: (n) => (n === 1 ? freeRead() : freeRead({ keyed: otherRequest() })),
      insert: () => null,
    });

    const result = await book();

    expect(result).toEqual({ kind: 'rejected', code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(store.attempts).toBe(2);
    expect(store.inserts).toHaveLength(1);
  });

  it('the key comes before the vehicle, the preferred technician and the slot', async () => {
    // A twin committed between the start check and the first read, and now
    // everything looks busy. Its booking is ours, so it's a replay.
    const asked = { ...KEYED_REQUEST, preferredTechnicianId: 'tech-1' };
    const { store, book } = setup({
      read: () =>
        freeRead({
          vehicleBusy: true,
          preferredTechnicianBusy: true,
          bayIds: [],
          technicianIds: [],
          keyed: sameRequest(asked),
        }),
      insert: () => {
        throw new Error('must not insert');
      },
    });

    // Nothing found at the start, and tech-1 works here with the skill, so
    // the request gets as far as the first read.
    store.lookupResult = goodLookup({
      keyed: null,
      preferredTechnician: { id: 'tech-1', dealershipId: 'north', skillCodes: ['OIL_SERVICE'] },
    });

    const result = await book(asked);

    expect(result).toEqual({ kind: 'replayed', appointment: ORIGINAL });
    expect(store.attempts).toBe(1);
  });

  it('a reused key found in the read also comes before the vehicle check', async () => {
    const { book } = setup({
      read: () => freeRead({ vehicleBusy: true, keyed: otherRequest() }),
      insert: () => {
        throw new Error('must not insert');
      },
    });

    const result = await book();

    expect(result).toEqual({ kind: 'rejected', code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('every attempt asks the read about the key, not only the first', async () => {
    const { store, book } = setup({
      read: () => freeRead(),
      insert: (n, booking) => (n < 3 ? null : storedFrom(booking, 'appointment-new')),
    });

    await book();

    expect(store.reads).toHaveLength(3);
    for (const read of store.reads) {
      expect(read.idempotency).toEqual({ customerId: REQUEST.customerId, key: KEY });
    }
  });
});

describe('without a key', () => {
  it('a keyed row in the read is ignored when the request has no key', async () => {
    // Can't happen with the real store (it only looks when there's a key),
    // but the service must not replay somebody's booking for a keyless request.
    const { book } = setup({
      read: () => freeRead({ keyed: sameRequest() }),
      insert: (_n, booking) => storedFrom(booking, 'appointment-new'),
    });

    const result = await book({ idempotencyKey: null });

    expect(result).toMatchObject({ kind: 'created', appointment: { id: 'appointment-new' } });
  });
});
