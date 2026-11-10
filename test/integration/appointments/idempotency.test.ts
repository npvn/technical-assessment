import { randomUUID } from 'node:crypto';
import { DEFAULT_BOOKING_CONFIG } from '../../../src/appointments/booking.config.js';
import { BookingService } from '../../../src/appointments/booking.service.js';
import { PostgresBookingStore } from '../../../src/appointments/booking.store.js';
import type {
  Appointment,
  BookingRequest,
  BookingResult,
} from '../../../src/appointments/booking.types.js';
import { FixedClock, parseInstant } from '../../../src/scheduling/index.js';
import { createTestDatabase, type TestDatabase } from '../../support/test-database.js';
import { racingBookingService } from './race-barrier.js';
import {
  NORTH,
  OTHER,
  SOUTH,
  ask,
  bookingService,
  countOverlaps,
  countRows,
  insertServiceTypes,
  newWorld,
  tally,
  tue,
  type Car,
  type Place,
  type ServiceTypes,
} from './world.js';

// The Idempotency-Key on a real Postgres (AC-26 to AC-31, AC-42, AC-43,
// AC-45). Like booking.test.ts these assert domain results, the 201 and the
// Idempotent-Replayed header are the HTTP layer's job.
//
// The two races (AC-30, AC-45) go through the race barrier, so both requests
// have read "nothing booked with this key" before either inserts. Only the
// partial unique index on (customer_id, idempotency_key) and the key check
// inside the next attempt can then sort them out.

const POOL_SIZE = 10;
const LOOP_BUDGET_MS = 30_000;
const OIL = ['OIL_SERVICE'];
const BRAKES = ['BRAKES'];

let tdb: TestDatabase;
let types: ServiceTypes;
let service: BookingService;

beforeAll(async () => {
  tdb = await createTestDatabase({ poolSize: POOL_SIZE });
  types = await insertServiceTypes(tdb.db);
  service = bookingService(tdb.db);
});

afterAll(async () => {
  await tdb?.destroy();
});

function world() {
  return newWorld(tdb.db, types);
}

// Each test gets its own key, the rows of all tests share one database.
function newKey(): string {
  return `key-${randomUUID()}`;
}

async function north(bays: number, technicians: string[][]) {
  const w = world();
  const place = await w.place(NORTH, { name: 'North', bays, technicians });
  const car = await w.car();
  return { w, place, car };
}

function keyed(
  place: Place,
  car: Car,
  startTime: Date,
  key: string,
  extra: Partial<BookingRequest> = {},
) {
  return ask(types, place, car, startTime, { idempotencyKey: key, ...extra });
}

function created(result: BookingResult): Appointment {
  expect(result.kind).toBe('created');
  if (result.kind !== 'created') throw new Error(`expected created, got ${JSON.stringify(result)}`);
  return result.appointment;
}

// The rows that carry this key, whoever's they are.
async function rowsWithKey(key: string) {
  return tdb.db
    .selectFrom('appointments')
    .select(['id', 'customer_id', 'idempotency_key', 'request_hash', 'status'])
    .where('idempotency_key', '=', key)
    .orderBy('created_at')
    .execute();
}

// A second car for the same customer.
async function anotherVehicle(customerId: string): Promise<string> {
  const id = randomUUID();
  await tdb.db
    .insertInto('vehicles')
    .values({
      id,
      customer_id: customerId,
      vin: `TEST${randomUUID().replace(/-/g, '').slice(0, 13).toUpperCase()}`,
      make: 'Testmake',
      model: 'Testmodel',
      year: 2021,
    })
    .execute();
  return id;
}

function instant(text: string): Date {
  const parsed = parseInstant(text);
  if (!parsed) throw new Error(`test setup: ${text} did not parse`);
  return parsed;
}

describe('Idempotency-Key', () => {
  it('AC-26 same key and same request twice: created, then replayed with the same appointment, one row', async () => {
    const { place, car } = await north(2, [OIL]);
    const key = newKey();

    const first = created(await service.book(keyed(place, car, tue('09:00'), key)));
    const second = await service.book(keyed(place, car, tue('09:00'), key));

    expect(second).toEqual({ kind: 'replayed', appointment: first });
    expect(await countRows(tdb.db, { vehicleId: car.vehicleId })).toBe(1);
    // The key and the request hash are stored on the booking itself.
    const rows = await rowsWithKey(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, customer_id: car.customerId });
    expect(rows[0]?.request_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('AC-27 same key, a different request', () => {
    // North with bays 1 and 2, T1 and T2 for OIL and T3 for BRAKES, and South
    // with one OIL pair. The original takes bay 1 and T1 at 09:00. Each
    // variant changes one field. With the same key it must be 422. With a new
    // key it gets its normal answer (pinned below), so the 422 can only come
    // from the key and not from the request itself.
    const VARIANTS: [string, (s: Setup) => Partial<BookingRequest>, string][] = [
      ['dealershipId', (s) => ({ dealershipId: s.south.id }), 'VEHICLE_ALREADY_BOOKED'],
      ['serviceTypeId', () => ({ serviceTypeId: types.brakes }), 'VEHICLE_ALREADY_BOOKED'],
      ['vehicleId', (s) => ({ vehicleId: s.secondVehicle }), 'created'],
      [
        'preferredTechnicianId',
        (s) => ({ preferredTechnicianId: s.place.technicians[1] }),
        'VEHICLE_ALREADY_BOOKED',
      ],
      ['startTime', () => ({ startTime: tue('11:00') }), 'created'],
    ];

    interface Setup {
      place: Place;
      south: Place;
      car: Car;
      secondVehicle: string;
    }

    async function setup(): Promise<Setup> {
      const w = world();
      const place = await w.place(NORTH, {
        name: 'North',
        bays: 2,
        technicians: [OIL, OIL, BRAKES],
      });
      const south = await w.place(SOUTH, { name: 'South', bays: 1, technicians: [OIL] });
      const car = await w.car();
      const secondVehicle = await anotherVehicle(car.customerId);
      return { place, south, car, secondVehicle };
    }

    it.each(VARIANTS)(
      'AC-27 a change to %s: IDEMPOTENCY_KEY_REUSED, and nothing new is stored',
      async (_field, change, withNewKey) => {
        const s = await setup();
        const key = newKey();
        const original = created(await service.book(keyed(s.place, s.car, tue('09:00'), key)));
        const hashBefore = (await rowsWithKey(key))[0]?.request_hash;

        const reused = await service.book(keyed(s.place, s.car, tue('09:00'), key, change(s)));

        expect(reused).toEqual({ kind: 'rejected', code: 'IDEMPOTENCY_KEY_REUSED' });
        const rows = await rowsWithKey(key);
        expect(rows.map((r) => r.id)).toEqual([original.id]);
        expect(rows[0]?.request_hash).toBe(hashBefore);

        // The same changed request with a key nobody used yet gets its
        // ordinary answer.
        const fresh = await service.book(keyed(s.place, s.car, tue('09:00'), newKey(), change(s)));
        const answer = fresh.kind === 'rejected' ? fresh.code : fresh.kind;
        expect(answer).toBe(withNewKey);
      },
    );

    it('AC-27 a missing preferred technician and null are the same request: replay', async () => {
      const { place, car } = await north(2, [OIL]);
      const key = newKey();
      const first = created(await service.book(keyed(place, car, tue('09:00'), key)));

      const withoutField = keyed(place, car, tue('09:00'), key);
      delete withoutField.preferredTechnicianId;
      const again = await service.book(withoutField);

      expect(again).toEqual({ kind: 'replayed', appointment: first });
    });
  });

  it('AC-28 the same instant with another offset (10:00+01:00, then 09:00Z) is a replay, not 422', async () => {
    const { place, car } = await north(2, [OIL]);
    const key = newKey();

    const first = created(
      await service.book(keyed(place, car, instant('2027-03-09T10:00:00+01:00'), key)),
    );
    const again = await service.book(keyed(place, car, instant('2027-03-09T09:00:00Z'), key));

    expect(again).toEqual({ kind: 'replayed', appointment: first });
  });

  it('AC-29 the first request took the last free pair: the replay is the original, not 409', async () => {
    const { w, place, car } = await north(1, [OIL]);
    const key = newKey();
    const first = created(await service.book(keyed(place, car, tue('09:00'), key)));

    // The pair really is gone for anybody else.
    const other = await w.car();
    expect(await service.book(ask(types, place, other, tue('09:00')))).toEqual({
      kind: 'rejected',
      code: 'SLOT_UNAVAILABLE',
    });

    const again = await service.book(keyed(place, car, tue('09:00'), key));

    expect(again).toEqual({ kind: 'replayed', appointment: first });
    expect(await countRows(tdb.db, { dealershipId: place.id })).toBe(1);
  });

  it('AC-30 two parallel requests with the same key: one created, one replayed, same id, one row', async () => {
    const { place, car } = await north(2, [OIL, OIL]);
    const key = newKey();
    const racing = racingBookingService(tdb.db, 2, { loopBudgetMs: LOOP_BUDGET_MS });

    const results = await Promise.all([
      racing.book(keyed(place, car, tue('09:00'), key)),
      racing.book(keyed(place, car, tue('09:00'), key)),
    ]);

    expect(tally(results)).toEqual({ created: 1, replayed: 1 });
    const ids = results.map((r) =>
      r.kind === 'created' || r.kind === 'replayed' ? r.appointment.id : r.kind,
    );
    expect(ids[0]).toBe(ids[1]);
    expect(await countRows(tdb.db, { vehicleId: car.vehicleId })).toBe(1);
    expect((await rowsWithKey(key)).map((r) => r.id)).toEqual([ids[0]]);
    expect(await countOverlaps(tdb.db)).toBe(0);
  });

  it('AC-31 another customer with the same key K books a free slot: a new appointment, two rows', async () => {
    const { w, place, car: c1 } = await north(2, [OIL, OIL]);
    const c2 = await w.car();
    const key = newKey();

    const first = created(await service.book(keyed(place, c1, tue('09:00'), key)));
    const second = await service.book(keyed(place, c2, tue('09:00'), key));

    const mine = created(second);
    expect(mine.id).not.toBe(first.id);
    expect(mine.customerId).toBe(c2.customerId);
    // Both rows carry K, one per customer. A key is scoped to one customer (A15).
    const rows = await rowsWithKey(key);
    expect(rows.map((r) => [r.id, r.customer_id])).toEqual([
      [first.id, c1.customerId],
      [mine.id, c2.customerId],
    ]);
  });

  describe('AC-42 the key lookup comes before every other check', () => {
    it('AC-42 booked for Tue 09:00, the clock moves to Tue 12:00: a replay, not START_IN_PAST', async () => {
      const { place, car } = await north(2, [OIL]);
      const key = newKey();
      const first = created(await service.book(keyed(place, car, tue('09:00'), key)));

      const config = DEFAULT_BOOKING_CONFIG;
      const later = new BookingService(
        new PostgresBookingStore(tdb.db, config),
        new FixedClock(tue('12:00')),
        config,
      );

      expect(await later.book(keyed(place, car, tue('09:00'), key))).toEqual({
        kind: 'replayed',
        appointment: first,
      });
      // Without the key the same request is in the past now.
      expect(await later.book(keyed(place, car, tue('09:00'), newKey()))).toEqual({
        kind: 'rejected',
        code: 'START_IN_PAST',
      });
    });

    it('AC-42 the preferred technician is no longer eligible: still a replay', async () => {
      const w = world();
      const place = await w.place(NORTH, { name: 'North', bays: 2, technicians: [OIL, OIL] });
      const other = await w.place(OTHER, { name: 'Other', bays: 1, technicians: [OIL] });
      const car = await w.car();
      const t1 = place.technicians[0]!;
      const key = newKey();
      const request = keyed(place, car, tue('09:00'), key, { preferredTechnicianId: t1 });
      const first = created(await service.book(request));

      // The SPEC says "moved to another dealership with raw SQL". The
      // composite foreign key (dealership_id, technician_id) refuses that
      // while T1 has this appointment, so T1 loses the skill instead, which
      // gives the same TECHNICIAN_NOT_ELIGIBLE for a fresh request.
      await expect(
        tdb.db
          .updateTable('technicians')
          .set({ dealership_id: other.id })
          .where('id', '=', t1)
          .execute(),
      ).rejects.toMatchObject({ code: '23503' });
      await tdb.db.deleteFrom('technician_skills').where('technician_id', '=', t1).execute();

      expect(await service.book({ ...request, idempotencyKey: newKey() })).toEqual({
        kind: 'rejected',
        code: 'TECHNICIAN_NOT_ELIGIBLE',
      });
      expect(await service.book(request)).toEqual({ kind: 'replayed', appointment: first });
    });
  });

  it('AC-43 a 409 stores no key: after the blocking row is cancelled, the same key and request book fresh', async () => {
    const { w, place, car } = await north(1, [OIL]);
    const blocker = await w.existing({
      place,
      bay: place.bays[0]!,
      technician: place.technicians[0]!,
      start: tue('09:00'),
      end: tue('10:00'),
    });
    const key = newKey();

    expect(await service.book(keyed(place, car, tue('09:00'), key))).toEqual({
      kind: 'rejected',
      code: 'SLOT_UNAVAILABLE',
    });
    expect(await rowsWithKey(key)).toEqual([]);

    await tdb.db
      .updateTable('appointments')
      .set({ status: 'cancelled' })
      .where('id', '=', blocker)
      .execute();

    const again = created(await service.book(keyed(place, car, tue('09:00'), key)));

    expect(again.id).not.toBe(blocker);
    // Exactly one row with the key, the new one.
    expect((await rowsWithKey(key)).map((r) => r.id)).toEqual([again.id]);
  });

  it('AC-45 two parallel requests, same customer and key, different startTime: one created, one IDEMPOTENCY_KEY_REUSED, one row', async () => {
    // 09:00 and 11:00 don't overlap, so the vehicle constraint can't be what
    // stops the second one. Only the unique index on the key can.
    const { place, car } = await north(2, [OIL, OIL]);
    const key = newKey();
    const racing = racingBookingService(tdb.db, 2, { loopBudgetMs: LOOP_BUDGET_MS });
    const requests = [keyed(place, car, tue('09:00'), key), keyed(place, car, tue('11:00'), key)];

    const results = await Promise.all(requests.map((r) => racing.book(r)));

    expect(tally(results)).toEqual({ created: 1, IDEMPOTENCY_KEY_REUSED: 1 });
    // The winner got what it asked for, and the loser never got the
    // winner's booking back.
    const winner = results.findIndex((r) => r.kind === 'created');
    const booked = results[winner];
    if (booked?.kind !== 'created') throw new Error('no winner');
    expect(booked.appointment.startsAt).toEqual(requests[winner]!.startTime);
    expect(await countRows(tdb.db, { vehicleId: car.vehicleId })).toBe(1);
    expect((await rowsWithKey(key)).map((r) => r.id)).toEqual([booked.appointment.id]);
  });
});
