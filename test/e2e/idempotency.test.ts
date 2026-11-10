import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import {
  NORTH,
  NOW,
  insertServiceTypes,
  newWorld,
  type Car,
  type Place,
  type ServiceTypes,
} from '../integration/appointments/world.js';
import { SettableClock, bootApp, errorFields, expectProblem } from './app.js';

// The Idempotency-Key over HTTP: the header going in, Idempotent-Replayed
// coming out, and the 422 and 400 as problem+json. The ordering and the
// races are covered at service level in
// test/integration/appointments/idempotency.test.ts.

let testDb: TestDatabase;
let types: ServiceTypes;
let app: INestApplication;

beforeAll(async () => {
  testDb = await createTestDatabase();
  types = await insertServiceTypes(testDb.db);
  app = await bootApp({ databaseUrl: testDb.url, clock: new SettableClock(NOW) });
});

afterAll(async () => {
  await app?.close();
  await testDb?.destroy();
});

const http = () => request(app.getHttpServer());

async function north(): Promise<{ place: Place; car: Car }> {
  const world = newWorld(testDb.db, types);
  const place = await world.place(NORTH, {
    name: 'North',
    bays: 2,
    technicians: [['OIL_SERVICE']],
  });
  return { place, car: await world.car() };
}

function body(place: Place, car: Car, startTime: string) {
  return {
    dealershipId: place.id,
    serviceTypeId: types.oil,
    customerId: car.customerId,
    vehicleId: car.vehicleId,
    startTime,
  };
}

function post(key: string | undefined, payload: object) {
  const req = http().post('/appointments');
  return key === undefined ? req.send(payload) : req.set('Idempotency-Key', key).send(payload);
}

describe('POST /appointments with an Idempotency-Key', () => {
  it('AC-26 the same key and body twice: both 201 with the same body, only the second has Idempotent-Replayed: true', async () => {
    const { place, car } = await north();
    const key = `key-${randomUUID()}`;

    const first = await post(key, body(place, car, '2027-03-09T09:00:00Z'));
    const second = await post(key, body(place, car, '2027-03-09T09:00:00Z'));

    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.headers['content-type']).toMatch(/^application\/json/);
    expect(second.body).toEqual(first.body);
  });

  it('AC-28 the same instant written as 10:00+01:00 and then 09:00Z is a replay', async () => {
    const { place, car } = await north();
    const key = `key-${randomUUID()}`;

    const first = await post(key, body(place, car, '2027-03-09T10:00:00+01:00'));
    const second = await post(key, body(place, car, '2027-03-09T09:00:00Z'));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
  });

  it('AC-27 the same key with another startTime is 422 IDEMPOTENCY_KEY_REUSED as problem+json', async () => {
    const { place, car } = await north();
    const key = `key-${randomUUID()}`;
    await post(key, body(place, car, '2027-03-09T09:00:00Z')).expect(201);

    const res = await post(key, body(place, car, '2027-03-09T11:00:00Z'));

    expectProblem(res, 422, 'IDEMPOTENCY_KEY_REUSED');
    expect(res.headers['idempotent-replayed']).toBeUndefined();
  });

  // Node's HTTP client won't send control characters and trims the ends, so
  // only values that survive the trip are tried here. The rest are in the
  // parser's unit test.
  it.each([
    ['256 characters', 'k'.repeat(256)],
    ['a space inside', 'my key'],
    // An empty header is still a header, not "no key"
    ['nothing in it', ''],
  ])('a key with %s is 400 VALIDATION_FAILED naming the header', async (_name, key) => {
    const { place, car } = await north();

    const res = await post(key, body(place, car, '2027-03-09T09:00:00Z'));

    expectProblem(res, 400, 'VALIDATION_FAILED');
    expect(errorFields(res)).toEqual(['Idempotency-Key']);
    // Nothing was booked.
    const rows = await testDb.db
      .selectFrom('appointments')
      .select('id')
      .where('vehicle_id', '=', car.vehicleId)
      .execute();
    expect(rows).toEqual([]);
  });
});
