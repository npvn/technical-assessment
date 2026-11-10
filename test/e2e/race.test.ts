import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { RaceBarrier, RaceBarrierStore } from '../integration/appointments/race-barrier.js';
import {
  NORTH,
  NOW,
  countOverlaps,
  countRows,
  insertServiceTypes,
  newWorld,
  type Car,
  type ServiceTypes,
} from '../integration/appointments/world.js';
import { SettableClock, bootApp, expectProblem } from './app.js';

// AC-23 over real HTTP: 20 parallel POST /appointments for the last free
// slot, through the real AppModule, its validation, its error filter and its
// own pg pool. The service level version is in
// test/integration/appointments/concurrency.test.ts.
//
// The race has to really happen (CLAUDE.md rule 12). So the app's booking
// store is the real PostgresBookingStore with the test barrier wrapped around
// it: every request's first read waits until all 20 have read the slot as
// free, and only then do they insert. From there only the exclusion
// constraints can stop a double booking. Without the constraints this test
// gives 20 x 201 (docs/evidence/teeth-checks.md).
//
// While they wait at the barrier all 20 hold a transaction and a pool
// connection, so the app's pool has to be bigger than 20.
//
// The loop's time budget runs on the app clock, which is fixed here, so a
// slow machine can't turn a loser into a 503.

const PARALLEL = 20;
const POOL_SIZE = 30;
const OIL = ['OIL_SERVICE'];

let testDb: TestDatabase;
let types: ServiceTypes;
let app: INestApplication;
const barrier = new RaceBarrier(PARALLEL);

beforeAll(async () => {
  testDb = await createTestDatabase();
  types = await insertServiceTypes(testDb.db);
  app = await bootApp({
    databaseUrl: testDb.url,
    clock: new SettableClock(NOW),
    poolSize: POOL_SIZE,
    wrapStore: (real) => new RaceBarrierStore(real, barrier),
  });
  // Listening once up front. Otherwise supertest starts the server itself
  // for every request, and 20 of them at once would trip over each other.
  await app.listen(0);
});

afterAll(async () => {
  await app?.close();
  await testDb?.destroy();
});

it('AC-23 over HTTP: 1 bay and 1 technician, 20 parallel POSTs for 09:00 give one 201, nineteen 409 SLOT_UNAVAILABLE, one row', async () => {
  const world = newWorld(testDb.db, types);
  const place = await world.place(NORTH, { name: 'North', bays: 1, technicians: [OIL] });
  const drivers: Car[] = [];
  for (let i = 0; i < PARALLEL; i++) drivers.push(await world.car());

  const responses = await Promise.all(
    drivers.map((car) =>
      request(app.getHttpServer()).post('/appointments').send({
        dealershipId: place.id,
        serviceTypeId: types.oil,
        customerId: car.customerId,
        vehicleId: car.vehicleId,
        startTime: '2027-03-09T09:00:00Z',
      }),
    ),
  );

  // The tally first, so a broken run shows "201: 20" and not just the first
  // response that looked wrong.
  const tally: Record<string, number> = {};
  for (const res of responses) {
    const key = res.status === 201 ? '201' : `${res.status} ${res.body?.code}`;
    tally[key] = (tally[key] ?? 0) + 1;
  }
  expect(tally).toEqual({ '201': 1, '409 SLOT_UNAVAILABLE': 19 });

  for (const res of responses.filter((r) => r.status !== 201)) {
    expectProblem(res, 409, 'SLOT_UNAVAILABLE');
  }
  expect(await countRows(testDb.db, { dealershipId: place.id })).toBe(1);
  expect(await countOverlaps(testDb.db)).toBe(0);
});
