import { sql, type Kysely } from 'kysely';
import { DEFAULT_BOOKING_CONFIG } from '../../../src/appointments/booking.config.js';
import type { BookingService } from '../../../src/appointments/booking.service.js';
import { PostgresBookingStore } from '../../../src/appointments/booking.store.js';
import { createDatabase } from '../../../src/db/database.js';
import type { Database } from '../../../src/db/types.js';
import { createTestDatabase, type TestDatabase } from '../../support/test-database.js';
import {
  NORTH,
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
async function runAc24(db: Kysely<Database>, types: ServiceTypes, service: BookingService) {
  const w = newWorld(db, types);
  const place = await w.place(NORTH, {
    name: 'North',
    bays: 3,
    technicians: [OIL, OIL, OIL, OIL, OIL],
  });
  const drivers = await cars(w, 20);

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
  let service: BookingService;

  beforeAll(async () => {
    tdb = await createTestDatabase({ poolSize: POOL_SIZE });
    types = await insertServiceTypes(tdb.db);
    service = bookingService(tdb.db, { loopBudgetMs: LOOP_BUDGET_MS });
  });

  afterAll(async () => {
    await tdb?.destroy();
  });

  it('AC-23 1 bay and 1 technician, 20 parallel requests for 09:00: exactly one created, nineteen SLOT_UNAVAILABLE, one row', async () => {
    const w = newWorld(tdb.db, types);
    const place = await w.place(NORTH, { name: 'North', bays: 1, technicians: [OIL] });
    const drivers = await cars(w, 20);

    const results = await Promise.all(
      drivers.map((car) => service.book(ask(types, place, car, tue('09:00')))),
    );

    expect(tally(results)).toEqual({ created: 1, SLOT_UNAVAILABLE: 19 });
    expect(await countRows(tdb.db, { dealershipId: place.id })).toBe(1);
    expect(await countOverlaps(tdb.db)).toBe(0);
  });

  it('AC-24 3 bays and 5 technicians, 20 parallel requests for one slot: exactly 3 created, 17 SLOT_UNAVAILABLE, no 503, no overlaps', async () => {
    await runAc24(tdb.db, types, service);
  });

  it('AC-39 10 parallel requests all preferring T1: exactly one created with T1, nine TECHNICIAN_UNAVAILABLE, nobody gets T2', async () => {
    const w = newWorld(tdb.db, types);
    const place = await w.place(NORTH, { name: 'North', bays: 2, technicians: [OIL, OIL] });
    const [t1, t2] = place.technicians as [string, string];
    const drivers = await cars(w, 10);

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

    const results = await Promise.all([
      service.book(ask(types, north, car, tue('09:00'))),
      service.book(ask(types, south, car, tue('09:00'))),
    ]);

    expect(tally(results)).toEqual({ created: 1, VEHICLE_ALREADY_BOOKED: 1 });
    expect(await countRows(tdb.db, { vehicleId: car.vehicleId })).toBe(1);
    expect(await countOverlaps(tdb.db)).toBe(0);
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
  let service: BookingService;

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
    service = bookingService(db, { loopBudgetMs: LOOP_BUDGET_MS });
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
    await runAc24(db, types, service);
  });
});
