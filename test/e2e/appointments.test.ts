import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DEFAULT_BOOKING_CONFIG } from '../../src/appointments/booking.config.js';
import { PostgresBookingStore, type BookingStore } from '../../src/appointments/booking.store.js';
import { insertServiceType } from '../support/fixtures.js';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import {
  HARBOUR_HOURS,
  NORTH,
  NOW,
  OTHER,
  SOUTH,
  insertServiceTypes,
  newWorld,
  tue,
  type Car,
  type Place,
  type ServiceTypes,
} from '../integration/appointments/world.js';
import { SettableClock, bootApp, errorFields, expectProblem } from './app.js';

// POST /appointments and GET /appointments/:id through the real AppModule on
// a real Postgres, with the clock fixed at the SPEC's shared "now". The
// service level cases are in test/integration/appointments. This file checks
// what only HTTP can show: status codes, the body and its formats, validation
// and the problem+json shape. The full code to status table is a unit test
// (test/unit/appointments/http-mapping.test.ts), so here it's one case per
// status family.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// UTC, Z, no milliseconds
const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

let testDb: TestDatabase;
let types: ServiceTypes;
let app: INestApplication;
const clock = new SettableClock(NOW);

beforeAll(async () => {
  testDb = await createTestDatabase();
  types = await insertServiceTypes(testDb.db);
  app = await bootApp({ databaseUrl: testDb.url, clock });
});

afterEach(() => {
  clock.set(NOW);
});

afterAll(async () => {
  await app?.close();
  await testDb?.destroy();
});

const http = () => request(app.getHttpServer());

// North from the SPEC: London, two bays and one OIL_SERVICE technician unless
// a test says otherwise. Every call is a fresh world with its own ids.
async function north(
  spec: { bays?: number; technicians?: string[][] } = {},
): Promise<{ place: Place; car: Car; world: ReturnType<typeof newWorld> }> {
  const world = newWorld(testDb.db, types);
  const place = await world.place(NORTH, {
    name: 'North',
    bays: spec.bays ?? 2,
    technicians: spec.technicians ?? [['OIL_SERVICE']],
  });
  return { place, car: await world.car(), world };
}

// An OIL request body, startTime as the client would send it.
function body(place: Place, car: Car, startTime: string, extra: Record<string, unknown> = {}) {
  return {
    dealershipId: place.id,
    serviceTypeId: types.oil,
    customerId: car.customerId,
    vehicleId: car.vehicleId,
    startTime,
    ...extra,
  };
}

describe('POST /appointments', () => {
  it('AC-01 books bay 1 and T1 and answers 201 with the full body', async () => {
    const { place, car } = await north();

    const res = await http()
      .post('/appointments')
      .send(body(place, car, '2027-03-09T09:00:00Z'))
      .expect(201);

    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({
      id: expect.stringMatching(UUID),
      status: 'confirmed',
      customerId: car.customerId,
      vehicleId: car.vehicleId,
      dealershipId: place.id,
      serviceTypeId: types.oil,
      serviceBayId: place.bays[0],
      technicianId: place.technicians[0],
      startsAt: '2027-03-09T09:00:00Z',
      endsAt: '2027-03-09T10:00:00Z',
      startsAtLocal: '2027-03-09T09:00:00+00:00',
      endsAtLocal: '2027-03-09T10:00:00+00:00',
      timeZone: 'Europe/London',
      createdAt: expect.stringMatching(UTC_SECONDS),
    });
  });

  it('AC-01 the stored row has the request ids and the assigned bay and technician', async () => {
    const { place, car } = await north();

    const res = await http()
      .post('/appointments')
      .send(body(place, car, '2027-03-09T09:00:00Z'))
      .expect(201);

    const row = await testDb.db
      .selectFrom('appointments')
      .selectAll()
      .where('id', '=', res.body.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      customer_id: car.customerId,
      vehicle_id: car.vehicleId,
      dealership_id: place.id,
      service_type_id: types.oil,
      service_bay_id: place.bays[0],
      technician_id: place.technicians[0],
      starts_at: tue('09:00'),
      ends_at: tue('10:00'),
      status: 'confirmed',
    });
  });

  // London is on UTC in early March, so AC-01 alone can't tell real local
  // formatting from the UTC time with +00:00 stuck on the end.
  it('AC-14 local times follow British Summer Time (+01:00)', async () => {
    const { place, car } = await north();

    const res = await http()
      .post('/appointments')
      .send(body(place, car, '2027-03-29T08:00:00+01:00'))
      .expect(201);

    expect(res.body).toMatchObject({
      startsAt: '2027-03-29T07:00:00Z',
      endsAt: '2027-03-29T08:00:00Z',
      startsAtLocal: '2027-03-29T08:00:00+01:00',
      endsAtLocal: '2027-03-29T09:00:00+01:00',
      timeZone: 'Europe/London',
    });
  });

  it('AC-13 local times are in the dealership zone, whatever offset the request used', async () => {
    const world = newWorld(testDb.db, types);
    const harbour = await world.place(OTHER, {
      name: 'Harbour',
      timeZone: 'Australia/Sydney',
      hours: HARBOUR_HOURS,
      bays: 1,
      technicians: [['OIL_SERVICE']],
    });
    const car = await world.car();

    const res = await http()
      .post('/appointments')
      .send(body(harbour, car, '2027-03-07T21:00:00Z'))
      .expect(201);

    expect(res.body).toMatchObject({
      startsAt: '2027-03-07T21:00:00Z',
      startsAtLocal: '2027-03-08T08:00:00+11:00',
      endsAtLocal: '2027-03-08T09:00:00+11:00',
      timeZone: 'Australia/Sydney',
    });
  });

  describe('AC-15 a start off the 15 minute grid is 422 START_NOT_ON_GRID', () => {
    it.each(['2027-03-09T09:07:00Z', '2027-03-09T09:00:30Z', '2027-03-09T09:00:00.001Z'])(
      'AC-15 %s',
      async (startTime) => {
        const { place, car } = await north();
        const res = await http()
          .post('/appointments')
          .send(body(place, car, startTime));
        expectProblem(res, 422, 'START_NOT_ON_GRID');
      },
    );
  });

  describe('AC-16 the booking window', () => {
    it.each(['2027-03-01T09:00:00Z', '2027-03-01T08:45:00Z'])(
      'AC-16 %s (now or earlier) is 422 START_IN_PAST',
      async (startTime) => {
        const { place, car } = await north();
        const res = await http()
          .post('/appointments')
          .send(body(place, car, startTime));
        expectProblem(res, 422, 'START_IN_PAST');
      },
    );

    it('AC-16 the next slot after now is 201', async () => {
      const { place, car } = await north();
      await http()
        .post('/appointments')
        .send(body(place, car, '2027-03-01T09:15:00Z'))
        .expect(201);
    });

    // 31 May 2027 is a UK bank holiday. Closure days are out of scope, so
    // North is open as on any Monday. Don't "fix" this.
    it('AC-16 exactly 90 x 24 hours ahead is 201, one slot later is 422 BEYOND_BOOKING_HORIZON', async () => {
      clock.set(new Date('2027-03-02T09:00:00Z'));
      const { place, car, world } = await north();

      await http()
        .post('/appointments')
        .send(body(place, car, '2027-05-31T09:00:00Z'))
        .expect(201);

      const other = await world.car();
      const res = await http()
        .post('/appointments')
        .send(body(place, other, '2027-05-31T09:15:00Z'));
      expectProblem(res, 422, 'BEYOND_BOOKING_HORIZON');
    });
  });

  describe('AC-17 startTime must be a full ISO 8601 date and time with an offset', () => {
    it.each([
      '2027-03-09T09:00:00',
      '2027-03-09',
      '2027-02-30T09:00:00Z',
      '2027-03-09T09:00:00+25:00',
      '2027-03-09T09:00:00+14:30',
      '2027-03-09 09:00:00Z',
      'tomorrow',
    ])('AC-17 %s is 400 VALIDATION_FAILED naming startTime', async (startTime) => {
      const { place, car } = await north();
      const res = await http()
        .post('/appointments')
        .send(body(place, car, startTime));
      expectProblem(res, 400, 'VALIDATION_FAILED');
      expect(errorFields(res)).toEqual(['startTime']);
    });

    it('AC-17 a number instead of a string is 400 naming startTime', async () => {
      const { place, car } = await north();
      const res = await http()
        .post('/appointments')
        .send(body(place, car, '2027-03-09T09:00:00Z', { startTime: 1_804_496_400_000 }));
      expectProblem(res, 400, 'VALIDATION_FAILED');
      expect(errorFields(res)).toEqual(['startTime']);
    });

    it('AC-17 2027-03-09T09:00Z (no seconds) is accepted as 09:00:00Z', async () => {
      const { place, car } = await north();
      const res = await http()
        .post('/appointments')
        .send(body(place, car, '2027-03-09T09:00Z'))
        .expect(201);
      expect(res.body.startsAt).toBe('2027-03-09T09:00:00Z');
    });
  });

  describe('AC-18 unknown ids are 404, a car that belongs to someone else is 422', () => {
    it.each([
      ['dealershipId', 'DEALERSHIP_NOT_FOUND'],
      ['serviceTypeId', 'SERVICE_TYPE_NOT_FOUND'],
      ['customerId', 'CUSTOMER_NOT_FOUND'],
      ['vehicleId', 'VEHICLE_NOT_FOUND'],
    ])('AC-18 an unknown %s is 404 %s', async (field, code) => {
      const { place, car } = await north();
      const res = await http()
        .post('/appointments')
        .send(body(place, car, '2027-03-09T09:00:00Z', { [field]: randomUUID() }));
      expectProblem(res, 404, code);
    });

    it('AC-09 an unknown preferred technician is 404 TECHNICIAN_NOT_FOUND', async () => {
      const { place, car } = await north();
      const res = await http()
        .post('/appointments')
        .send(body(place, car, '2027-03-09T09:00:00Z', { preferredTechnicianId: randomUUID() }));
      expectProblem(res, 404, 'TECHNICIAN_NOT_FOUND');
    });

    it('AC-18 the vehicle belongs to another customer: 422 VEHICLE_NOT_OWNED_BY_CUSTOMER', async () => {
      const { place, car, world } = await north();
      const someoneElse = await world.car();
      const res = await http()
        .post('/appointments')
        .send(body(place, car, '2027-03-09T09:00:00Z', { customerId: someoneElse.customerId }));
      expectProblem(res, 422, 'VEHICLE_NOT_OWNED_BY_CUSTOMER');
    });
  });

  describe('AC-20 a bad body is 400 VALIDATION_FAILED naming the field', () => {
    it('AC-20 a missing vehicleId', async () => {
      const { place, car } = await north();
      const withoutVehicle: Record<string, unknown> = body(place, car, '2027-03-09T09:00:00Z');
      delete withoutVehicle.vehicleId;
      const res = await http().post('/appointments').send(withoutVehicle);
      expectProblem(res, 400, 'VALIDATION_FAILED');
      expect(errorFields(res)).toEqual(['vehicleId']);
      expect(res.body.errors[0].message).toEqual(expect.any(String));
    });

    it('AC-20 an id that is not a UUID', async () => {
      const { place, car } = await north();
      const res = await http()
        .post('/appointments')
        .send(body(place, car, '2027-03-09T09:00:00Z', { dealershipId: 'abc' }));
      expectProblem(res, 400, 'VALIDATION_FAILED');
      expect(errorFields(res)).toEqual(['dealershipId']);
    });

    it('AC-20 an extra field', async () => {
      const { place, car } = await north();
      const res = await http()
        .post('/appointments')
        .send(body(place, car, '2027-03-09T09:00:00Z', { foo: 1 }));
      expectProblem(res, 400, 'VALIDATION_FAILED');
      expect(errorFields(res)).toEqual(['foo']);
    });

    it('AC-20 a preferredTechnicianId that is not a UUID', async () => {
      const { place, car } = await north();
      const res = await http()
        .post('/appointments')
        .send(body(place, car, '2027-03-09T09:00:00Z', { preferredTechnicianId: 'T1' }));
      expectProblem(res, 400, 'VALIDATION_FAILED');
      expect(errorFields(res)).toEqual(['preferredTechnicianId']);
    });

    it('a body that is not JSON at all is 400 problem+json', async () => {
      const res = await http()
        .post('/appointments')
        .set('Content-Type', 'application/json')
        .send('{"dealershipId": ');
      expectProblem(res, 400, 'VALIDATION_FAILED');
    });
  });

  it('a preferredTechnicianId of null is the same as leaving it out', async () => {
    const { place, car } = await north();
    const res = await http()
      .post('/appointments')
      .send(body(place, car, '2027-03-09T09:00:00Z', { preferredTechnicianId: null }))
      .expect(201);
    expect(res.body.technicianId).toBe(place.technicians[0]);
  });

  it('AC-37 a bad UUID is a 400 even when the vehicle is also unknown', async () => {
    const { place, car } = await north();
    const res = await http()
      .post('/appointments')
      .send(
        body(place, car, '2027-03-09T09:00:00Z', { dealershipId: 'abc', vehicleId: randomUUID() }),
      );
    expectProblem(res, 400, 'VALIDATION_FAILED');
    expect(errorFields(res)).toEqual(['dealershipId']);
  });

  it('AC-03 a taken slot is 409 SLOT_UNAVAILABLE', async () => {
    const { place, car, world } = await north({
      bays: 1,
      technicians: [['OIL_SERVICE'], ['OIL_SERVICE']],
    });
    await world.existing({
      place,
      bay: place.bays[0]!,
      technician: place.technicians[1]!,
      start: tue('09:00'),
      end: tue('10:00'),
    });

    const res = await http()
      .post('/appointments')
      .send(body(place, car, '2027-03-09T09:30:00Z'));
    expectProblem(res, 409, 'SLOT_UNAVAILABLE');
  });

  it('AC-10 the same car booked at South at that time is 409 VEHICLE_ALREADY_BOOKED', async () => {
    const world = newWorld(testDb.db, types);
    const south = await world.place(SOUTH, {
      name: 'South',
      bays: 1,
      technicians: [['OIL_SERVICE']],
    });
    const northPlace = await world.place(NORTH, {
      name: 'North',
      bays: 2,
      technicians: [['OIL_SERVICE']],
    });
    const car = await world.car();
    await world.existing({
      place: south,
      bay: south.bays[0]!,
      technician: south.technicians[0]!,
      start: tue('10:00'),
      end: tue('11:00'),
      car,
    });

    const res = await http()
      .post('/appointments')
      .send(body(northPlace, car, '2027-03-09T10:30:00Z'));
    expectProblem(res, 409, 'VEHICLE_ALREADY_BOOKED');
  });
});

describe('GET /appointments/:id', () => {
  it('AC-32 returns 200 with the same body the 201 had', async () => {
    const { place, car } = await north();
    const created = await http()
      .post('/appointments')
      .send(body(place, car, '2027-03-09T09:00:00Z'))
      .expect(201);

    const res = await http().get(`/appointments/${created.body.id}`).expect(200);

    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual(created.body);
  });

  it('AC-32 local times on a read are in the dealership zone too', async () => {
    const { place, car } = await north();
    const created = await http()
      .post('/appointments')
      .send(body(place, car, '2027-03-29T08:00:00+01:00'))
      .expect(201);

    const res = await http().get(`/appointments/${created.body.id}`).expect(200);
    expect(res.body.startsAtLocal).toBe('2027-03-29T08:00:00+01:00');
  });

  it('AC-32 an unknown id is 404 APPOINTMENT_NOT_FOUND', async () => {
    const res = await http().get(`/appointments/${randomUUID()}`);
    expectProblem(res, 404, 'APPOINTMENT_NOT_FOUND');
  });

  it('AC-32 an id that is not a UUID is 400 VALIDATION_FAILED', async () => {
    const res = await http().get('/appointments/not-a-uuid');
    expectProblem(res, 400, 'VALIDATION_FAILED');
    expect(errorFields(res)).toEqual(['id']);
  });

  it('AC-44 a later change to the service duration does not move the stored end', async () => {
    // Its own service type, so the duration change can't leak into other tests
    const oil = await insertServiceType(testDb.db, {
      durationMinutes: 60,
      requiredSkill: 'OIL_SERVICE',
    });
    const { place, car } = await north();
    const created = await http()
      .post('/appointments')
      .send(body(place, car, '2027-03-09T09:00:00Z', { serviceTypeId: oil }))
      .expect(201);

    await testDb.db
      .updateTable('service_types')
      .set({ duration_minutes: 90 })
      .where('id', '=', oil)
      .execute();

    const res = await http().get(`/appointments/${created.body.id}`).expect(200);
    expect(res.body.endsAt).toBe('2027-03-09T10:00:00Z');
    expect(res.body.endsAtLocal).toBe('2027-03-09T10:00:00+00:00');
  });
});

describe('everything else', () => {
  // This was test/e2e/boot.test.ts before the app needed a database.
  it('an unknown route is 404 problem+json', async () => {
    const res = await http().get('/nope');
    expectProblem(res, 404, 'NOT_FOUND');
  });

  it('AC-32 GET /docs serves the OpenAPI UI', async () => {
    const res = await http().get('/docs').redirects(1).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
  });

  it('AC-32 GET /docs-json lists both endpoints with every error they can answer', async () => {
    const res = await http().get('/docs-json').expect(200);
    const paths = res.body.paths as Record<string, Record<string, { responses: object }>>;

    const post = paths['/appointments']?.post;
    expect(Object.keys(post?.responses ?? {}).sort()).toEqual(
      ['201', '400', '404', '409', '422', '503'].sort(),
    );

    const get = paths['/appointments/{id}']?.get;
    expect(Object.keys(get?.responses ?? {}).sort()).toEqual(['200', '400', '404'].sort());
  });
});

// Two cases a real database can't produce on demand, so the store is
// swapped. Everything else (validation, the lookups, the mapping and the
// filter) is the real thing.
describe('with a swapped store', () => {
  let swapped: INestApplication;
  let mode: 'statement_timeout' | 'crash' = 'statement_timeout';

  beforeAll(async () => {
    const real = new PostgresBookingStore(testDb.db, DEFAULT_BOOKING_CONFIG);
    const store: BookingStore = {
      lookup: (req) =>
        mode === 'crash'
          ? Promise.reject(new Error('kaboom: password=hunter2 at 10.0.0.7'))
          : real.lookup(req),
      // A pg style error, as Kysely passes it on
      runAttempt: () =>
        Promise.reject(
          Object.assign(new Error('canceling statement due to statement timeout'), {
            code: '57014',
          }),
        ),
    };
    swapped = await bootApp({ databaseUrl: testDb.url, clock, store });
  });

  afterAll(async () => {
    await swapped?.close();
  });

  it('AC-41 a statement timeout is 503 BOOKING_CONTENDED with Retry-After: 1', async () => {
    mode = 'statement_timeout';
    const { place, car } = await north();

    const res = await request(swapped.getHttpServer())
      .post('/appointments')
      .send(body(place, car, '2027-03-09T09:00:00Z'));

    expectProblem(res, 503, 'BOOKING_CONTENDED');
    expect(res.headers['retry-after']).toBe('1');
    // The reason is internal, for logs and metrics
    expect(res.text).not.toContain('statement_timeout');
    expect(res.text).not.toContain('57014');
    expect(res.text).not.toContain('canceling statement');
  });

  it('an unexpected error is a 500 that does not leak what went wrong', async () => {
    mode = 'crash';
    const { place, car } = await north();

    const res = await request(swapped.getHttpServer())
      .post('/appointments')
      .send(body(place, car, '2027-03-09T09:00:00Z'));

    expectProblem(res, 500, 'INTERNAL_ERROR');
    expect(res.text).not.toContain('kaboom');
    expect(res.text).not.toContain('hunter2');
    expect(res.text).not.toContain('10.0.0.7');
  });
});
