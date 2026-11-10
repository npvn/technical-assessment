import { sql, type Kysely } from 'kysely';
import { DEFAULT_BOOKING_CONFIG } from '../../../src/appointments/booking.config.js';
import type { BookingRecord } from '../../../src/appointments/booking.observer.js';
import { BookingService } from '../../../src/appointments/booking.service.js';
import {
  PostgresBookingStore,
  type BookingStore,
} from '../../../src/appointments/booking.store.js';
import { createDatabase } from '../../../src/db/database.js';
import type { Database } from '../../../src/db/types.js';
import { FixedClock } from '../../../src/scheduling/index.js';
import { insertAppointment } from '../../support/fixtures.js';
import { createTestDatabase, type TestDatabase } from '../../support/test-database.js';
import { racingBookingService } from './race-barrier.js';
import {
  NORTH,
  NOW,
  SOUTH,
  ask,
  countOverlaps,
  countRows,
  insertServiceTypes,
  newWorld,
  tally,
  tue,
  type Car,
  type ServiceTypes,
} from './world.js';

// Parallel requests straight into the booking service on a real Postgres
// (AC-23, AC-24, AC-38, AC-39, AC-40). The pool is bigger than the number of
// parallel requests, or the pool would queue them and the race would never
// happen. The loop budget is generous so a slow machine doesn't turn a race
// into a 503 for a reason that has nothing to do with the rule.
//
// After each run one SQL query checks the table itself for overlapping rows,
// so the test doesn't rest on the result counts alone.
//
// Every race goes through a test-only barrier (race-barrier.ts): each
// request's first read waits until all of them have read, and only then do
// they insert. Without it AC-23 passed even with the three exclusion
// constraints dropped. It runs first on a cold pool, opening the connections
// and the lookups spread the 20 requests out, the first booking committed
// before most of the others read, and they honestly saw "no slot". With the
// barrier all 20 have seen the slot free before anybody inserts, so only the
// constraints can stop the double booking. It also takes the timing luck out
// of AC-24, AC-39 and AC-40.

const POOL_SIZE = 30;
const LOOP_BUDGET_MS = 30_000;
const OIL = ['OIL_SERVICE'];

async function cars(world: ReturnType<typeof newWorld>, count: number): Promise<Car[]> {
  const list: Car[] = [];
  for (let i = 0; i < count; i++) list.push(await world.car());
  return list;
}

// AC-24's setup and checks, shared with AC-38 which runs it again on a
// database whose default isolation level is REPEATABLE READ.
async function runAc24(db: Kysely<Database>, types: ServiceTypes) {
  const w = newWorld(db, types);
  const place = await w.place(NORTH, {
    name: 'North',
    bays: 3,
    technicians: [OIL, OIL, OIL, OIL, OIL],
  });
  const drivers = await cars(w, 20);
  const service = racingBookingService(db, drivers.length, { loopBudgetMs: LOOP_BUDGET_MS });

  const results = await Promise.all(
    drivers.map((car) => service.book(ask(types, place, car, tue('09:00')))),
  );

  // Exactly min(3 bays, 5 technicians) created, the rest an honest 409, no 503.
  expect(tally(results)).toEqual({ created: 3, SLOT_UNAVAILABLE: 17 });
  expect(await countRows(db, { dealershipId: place.id })).toBe(3);
  expect(await countOverlaps(db)).toBe(0);
}

describe('Concurrency', () => {
  let tdb: TestDatabase;
  let types: ServiceTypes;

  beforeAll(async () => {
    tdb = await createTestDatabase({ poolSize: POOL_SIZE });
    types = await insertServiceTypes(tdb.db);
  });

  afterAll(async () => {
    await tdb?.destroy();
  });

  it('AC-23 1 bay and 1 technician, 20 parallel requests for 09:00: exactly one created, nineteen SLOT_UNAVAILABLE, one row', async () => {
    const w = newWorld(tdb.db, types);
    const place = await w.place(NORTH, { name: 'North', bays: 1, technicians: [OIL] });
    const drivers = await cars(w, 20);
    const service = racingBookingService(tdb.db, drivers.length, { loopBudgetMs: LOOP_BUDGET_MS });

    const results = await Promise.all(
      drivers.map((car) => service.book(ask(types, place, car, tue('09:00')))),
    );

    expect(tally(results)).toEqual({ created: 1, SLOT_UNAVAILABLE: 19 });
    expect(await countRows(tdb.db, { dealershipId: place.id })).toBe(1);
    expect(await countOverlaps(tdb.db)).toBe(0);
  });

  it('AC-24 3 bays and 5 technicians, 20 parallel requests for one slot: exactly 3 created, 17 SLOT_UNAVAILABLE, no 503, no overlaps', async () => {
    await runAc24(tdb.db, types);
  });

  it('AC-39 10 parallel requests all preferring T1: exactly one created with T1, nine TECHNICIAN_UNAVAILABLE, nobody gets T2', async () => {
    const w = newWorld(tdb.db, types);
    const place = await w.place(NORTH, { name: 'North', bays: 2, technicians: [OIL, OIL] });
    const [t1, t2] = place.technicians as [string, string];
    const drivers = await cars(w, 10);
    const service = racingBookingService(tdb.db, drivers.length, { loopBudgetMs: LOOP_BUDGET_MS });

    const results = await Promise.all(
      drivers.map((car) =>
        service.book(ask(types, place, car, tue('09:00'), { preferredTechnicianId: t1 })),
      ),
    );

    expect(tally(results)).toEqual({ created: 1, TECHNICIAN_UNAVAILABLE: 9 });
    const created = results.find((r) => r.kind === 'created');
    expect(created).toMatchObject({ appointment: { technicianId: t1 } });
    expect(await countRows(tdb.db, { dealershipId: place.id })).toBe(1);
    expect(await countRows(tdb.db, { technicianId: t2 })).toBe(0);
    expect(await countOverlaps(tdb.db)).toBe(0);
  });

  it('AC-40 the same vehicle at North and at South at the same instant: one created, one VEHICLE_ALREADY_BOOKED, one row', async () => {
    const w = newWorld(tdb.db, types);
    const south = await w.place(SOUTH, { name: 'South', bays: 1, technicians: [OIL] });
    const north = await w.place(NORTH, { name: 'North', bays: 1, technicians: [OIL] });
    const car = await w.car();
    const service = racingBookingService(tdb.db, 2, { loopBudgetMs: LOOP_BUDGET_MS });

    const results = await Promise.all([
      service.book(ask(types, north, car, tue('09:00'))),
      service.book(ask(types, south, car, tue('09:00'))),
    ]);

    expect(tally(results)).toEqual({ created: 1, VEHICLE_ALREADY_BOOKED: 1 });
    expect(await countRows(tdb.db, { vehicleId: car.vehicleId })).toBe(1);
    expect(await countOverlaps(tdb.db)).toBe(0);
  });
});

// The booking transaction sets its own lock_timeout with SET LOCAL. Shown by
// behaviour: another transaction holds an overlapping row on the same bay and
// doesn't commit, so the insert has to wait for it. The test database's
// session default is 10 s, so failing within about a second proves the
// store's 200 ms really reached the booking transaction.
describe('Timeouts on the booking transaction', () => {
  let tdb: TestDatabase;
  let types: ServiceTypes;

  beforeAll(async () => {
    tdb = await createTestDatabase({ poolSize: 5 });
    types = await insertServiceTypes(tdb.db);
  });

  afterAll(async () => {
    await tdb?.destroy();
  });

  it('lock_timeout is set on the attempt: an insert stuck behind an open clash on the same bay throws 55P03 quickly', async () => {
    const w = newWorld(tdb.db, types);
    const place = await w.place(NORTH, { name: 'North', bays: 1, technicians: [OIL, OIL] });
    const [bay1] = place.bays as [string];
    const [t1, t2] = place.technicians as [string, string];
    const car = await w.car();
    const other = await w.car();
    const store = new PostgresBookingStore(tdb.db, {
      ...DEFAULT_BOOKING_CONFIG,
      lockTimeoutMs: 200,
    });
    const range = { start: tue('09:00'), end: tue('10:00') };

    // The blocker: an overlapping row on bay 1, inserted and left uncommitted.
    const blocker = await tdb.db.startTransaction().execute();
    try {
      await insertAppointment(blocker, {
        dealershipId: place.id,
        serviceTypeId: types.oil,
        customerId: other.customerId,
        vehicleId: other.vehicleId,
        serviceBayId: bay1,
        technicianId: t2,
        startsAt: range.start,
        endsAt: range.end,
      });

      const started = performance.now();
      await expect(
        store.runAttempt((attempt) =>
          attempt.tryInsert({
            dealershipId: place.id,
            serviceTypeId: types.oil,
            customerId: car.customerId,
            vehicleId: car.vehicleId,
            serviceBayId: bay1,
            technicianId: t1,
            range,
          }),
        ),
      ).rejects.toMatchObject({ code: '55P03' });
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      await blocker.rollback().execute();
    }
  });

  // The same blocker, but now the lock timeout is long (10 s) and the
  // statement timeout is short (200 ms). The insert waits on the lock, so
  // the statement timeout is what ends it. The test pool's own session
  // statement_timeout is 30 s, so a 57014 within a second can only come
  // from the store's SET LOCAL. The pool sets the same value per session in
  // the app, so this half only matters behind PgBouncer, and nothing else
  // would notice it going missing.
  it('statement_timeout is set on the attempt: an insert stuck behind an open clash throws 57014 quickly', async () => {
    const w = newWorld(tdb.db, types);
    const place = await w.place(NORTH, { name: 'North', bays: 1, technicians: [OIL, OIL] });
    const [bay1] = place.bays as [string];
    const [t1, t2] = place.technicians as [string, string];
    const car = await w.car();
    const other = await w.car();
    const store = new PostgresBookingStore(tdb.db, {
      ...DEFAULT_BOOKING_CONFIG,
      lockTimeoutMs: 10_000,
      statementTimeoutMs: 200,
    });
    const range = { start: tue('09:00'), end: tue('10:00') };

    const blocker = await tdb.db.startTransaction().execute();
    let insert: Promise<unknown> = Promise.resolve();
    try {
      await insertAppointment(blocker, {
        dealershipId: place.id,
        serviceTypeId: types.oil,
        customerId: other.customerId,
        vehicleId: other.vehicleId,
        serviceBayId: bay1,
        technicianId: t2,
        startsAt: range.start,
        endsAt: range.end,
      });

      insert = store
        .runAttempt((attempt) =>
          attempt.tryInsert({
            dealershipId: place.id,
            serviceTypeId: types.oil,
            customerId: car.customerId,
            vehicleId: car.vehicleId,
            serviceBayId: bay1,
            technicianId: t1,
            range,
          }),
        )
        .then(
          () => 'inserted',
          (error: unknown) => error,
        );
      // Without the SET LOCAL the insert would wait out the 10 s lock
      // timeout, so the test gives up waiting after 2 s instead of hanging.
      const outcome = await Promise.race([
        insert,
        new Promise((resolve) => setTimeout(() => resolve('still waiting after 2 s'), 2_000)),
      ]);

      expect(outcome).toMatchObject({ code: '57014' });
    } finally {
      await blocker.rollback().execute();
      await insert;
    }
  });
});

// The retry of 40P01, 40001 and 55P03 (ADR 001 decision 6) on a real
// database, not the fake store. An uncommitted row holds the only bay and
// technician, so the first attempt's insert waits on it and gets 55P03 from
// the 200 ms lock timeout. The test rolls the blocker back right after that
// first failure and before the loop goes round again, so the retry finds the
// pair free and books it. No timing luck involved, the wrapper below decides
// when the blocker goes.
describe('the retry on a real database', () => {
  let tdb: TestDatabase;
  let types: ServiceTypes;

  beforeAll(async () => {
    tdb = await createTestDatabase({ poolSize: 5 });
    types = await insertServiceTypes(tdb.db);
  });

  afterAll(async () => {
    await tdb?.destroy();
  });

  it('a lock timeout (55P03) rolls the attempt back, and the retry books once the blocker is gone', async () => {
    const w = newWorld(tdb.db, types);
    const place = await w.place(NORTH, { name: 'North', bays: 1, technicians: [OIL] });
    const [bay1] = place.bays as [string];
    const [t1] = place.technicians as [string];
    const car = await w.car();
    const other = await w.car();
    const config = { ...DEFAULT_BOOKING_CONFIG, lockTimeoutMs: 200, loopBudgetMs: 30_000 };

    const blocker = await tdb.db.startTransaction().execute();
    let blockerOpen = true;
    const rollBackBlocker = async () => {
      if (!blockerOpen) return;
      blockerOpen = false;
      await blocker.rollback().execute();
    };

    // The real store, plus a note of how each attempt ended. When the first
    // one fails, the blocker is rolled back before the error reaches the loop.
    const real = new PostgresBookingStore(tdb.db, config);
    const attemptErrors: (string | null)[] = [];
    const store: BookingStore = {
      lookup: (request) => real.lookup(request),
      runAttempt: async (work) => {
        try {
          const result = await real.runAttempt(work);
          attemptErrors.push(null);
          return result;
        } catch (error) {
          attemptErrors.push((error as { code?: string }).code ?? 'no code');
          await rollBackBlocker();
          throw error;
        }
      },
    };
    const records: BookingRecord[] = [];
    const service = new BookingService(store, new FixedClock(NOW), config, {
      record: (record) => records.push(record),
    });

    try {
      await insertAppointment(blocker, {
        dealershipId: place.id,
        serviceTypeId: types.oil,
        customerId: other.customerId,
        vehicleId: other.vehicleId,
        serviceBayId: bay1,
        technicianId: t1,
        startsAt: tue('09:00'),
        endsAt: tue('10:00'),
      });

      // A throw is kept as the result, so a missing retry shows up in the
      // assertions below and not as a bare 55P03
      const result = await service
        .book(ask(types, place, car, tue('09:00')))
        .catch((error: unknown) => error);

      expect(attemptErrors).toEqual(['55P03', null]);
      expect(result).toMatchObject({
        kind: 'created',
        appointment: { serviceBayId: bay1, technicianId: t1, vehicleId: car.vehicleId },
      });
      expect(records).toEqual([
        expect.objectContaining({ outcome: 'created', attempts: 2, lostRaces: 0 }),
      ]);
      // The failed attempt left nothing behind and the blocker is gone
      expect(await countRows(tdb.db, { vehicleId: car.vehicleId })).toBe(1);
      expect(await countRows(tdb.db, { vehicleId: other.vehicleId })).toBe(0);
    } finally {
      await rollBackBlocker();
    }
  });
});

// The database default is REPEATABLE READ here. At that level a lost race in
// ON CONFLICT DO NOTHING raises 40001 instead of returning zero rows, so if the
// service trusted the default, races would turn into 503s. It sets READ
// COMMITTED on every booking transaction itself, so AC-24 has to hold as is.
describe('AC-38 a database whose default isolation is REPEATABLE READ', () => {
  let tdb: TestDatabase;
  let db: Kysely<Database>;
  let types: ServiceTypes;

  beforeAll(async () => {
    tdb = await createTestDatabase({ poolSize: 1 });
    const name = new URL(tdb.url).pathname.slice(1);
    await sql
      .raw(`ALTER DATABASE ${name} SET default_transaction_isolation = 'repeatable read'`)
      .execute(tdb.db);
    // ALTER DATABASE only reaches new sessions, so the booking gets a fresh
    // pool opened after it.
    db = createDatabase({
      url: tdb.url,
      poolSize: POOL_SIZE,
      statementTimeoutMs: 30_000,
      lockTimeoutMs: 10_000,
    });
    // A guard, not a test: if the new sessions don't really default to
    // REPEATABLE READ, this case proves nothing.
    const { rows } = await sql<{
      level: string;
    }>`SELECT current_setting('default_transaction_isolation') AS level`.execute(db);
    if (rows[0]?.level !== 'repeatable read') {
      throw new Error(`expected repeatable read, the pool has ${rows[0]?.level}`);
    }
    types = await insertServiceTypes(db);
  });

  afterAll(async () => {
    await db?.destroy();
    await tdb?.destroy();
  });

  // The AC-24 rerun alone could pass even if the store trusted the default:
  // each 40001 would just be retried, and a fresh snapshot then sees the new
  // row. This one is deterministic. A clash committed after the attempt's
  // snapshot gives zero rows at READ COMMITTED, but 40001 at REPEATABLE READ.
  it('AC-38 an attempt runs at READ COMMITTED: a clash committed after its first read makes the insert return null, not 40001', async () => {
    const w = newWorld(db, types);
    const place = await w.place(NORTH, { name: 'North', bays: 1, technicians: [OIL, OIL] });
    const [bay1] = place.bays as [string];
    const [t1, t2] = place.technicians as [string, string];
    const car = await w.car();
    const store = new PostgresBookingStore(db, DEFAULT_BOOKING_CONFIG);
    const range = { start: tue('09:00'), end: tue('10:00') };

    const inserted = await store.runAttempt(async (attempt) => {
      const read = await attempt.readSlot({
        dealershipId: place.id,
        vehicleId: car.vehicleId,
        skillCode: 'OIL_SERVICE',
        range,
        preferredTechnicianId: null,
      });
      expect(read.bayIds).toEqual([bay1]);
      // Somebody else takes bay 1 and commits, on another connection.
      await w.existing({ place, bay: bay1, technician: t2, start: range.start, end: range.end });
      return attempt.tryInsert({
        dealershipId: place.id,
        serviceTypeId: types.oil,
        customerId: car.customerId,
        vehicleId: car.vehicleId,
        serviceBayId: bay1,
        technicianId: t1,
        range,
      });
    });

    expect(inserted).toBeNull();
  });

  it('AC-38 AC-24 still holds: exactly 3 created, 17 SLOT_UNAVAILABLE, no 503', async () => {
    await runAc24(db, types);
  });
});
