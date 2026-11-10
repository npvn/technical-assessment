import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import {
  HARBOUR_HOURS,
  NORTH,
  NOW,
  OTHER,
  insertServiceTypes,
  newWorld,
  type Place,
  type ServiceTypes,
} from '../integration/appointments/world.js';
import { SettableClock, bootApp, errorFields, expectProblem } from './app.js';

// GET /availability through the real AppModule on a real Postgres, with the
// clock fixed at the SPEC's shared "now" (Mon 1 March 2027 09:00 UTC). The
// slot rules themselves are unit tested in
// test/unit/availability/compute-slots.test.ts. This file checks what only
// the app can show: the day query (which rows count, the local day), the
// body and its time formats, validation, the 404s and the OpenAPI entry.

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

// North from the SPEC: London, two bays and two OIL_SERVICE technicians
// unless a test says otherwise. A fresh world with its own ids every call.
async function north(spec: { bays?: number; technicians?: string[][] } = {}) {
  const world = newWorld(testDb.db, types);
  const place = await world.place(NORTH, {
    name: 'North',
    bays: spec.bays ?? 2,
    technicians: spec.technicians ?? [['OIL_SERVICE'], ['OIL_SERVICE']],
  });
  return { place, world };
}

function availability(query: Record<string, string>) {
  return http().get('/availability').query(query);
}

function oilAt(place: Place, date: string) {
  return availability({ dealershipId: place.id, serviceTypeId: types.oil, date });
}

// Every 15 minutes from first to last, both included, as UTC strings with Z.
// None of the ranges here cross a clock change, so plain UTC steps are fine.
function every15(firstIso: string, lastIso: string): string[] {
  const out: string[] = [];
  for (let t = new Date(firstIso).getTime(); t <= new Date(lastIso).getTime(); t += 15 * 60_000) {
    out.push(new Date(t).toISOString().replace('.000Z', 'Z'));
  }
  return out;
}

function startsOf(res: Response): string[] {
  return (res.body.slots as { startsAt: string }[]).map((s) => s.startsAt);
}

describe('GET /availability', () => {
  it('AC-33 North, OIL, no bookings, Tue 9 March: 200 with 35 starts and the full body', async () => {
    const { place } = await north();

    const res = await oilAt(place, '2027-03-09').expect(200);

    expect(res.headers['content-type']).toMatch(/^application\/json/);
    // London is on UTC in early March, so the local time is the same clock
    // time with +00:00 (never Z)
    expect(res.body).toEqual({
      dealershipId: place.id,
      serviceTypeId: types.oil,
      date: '2027-03-09',
      timeZone: 'Europe/London',
      slots: every15('2027-03-09T08:00:00Z', '2027-03-09T16:30:00Z').map((startsAt) => ({
        startsAt,
        startsAtLocal: startsAt.replace('Z', '+00:00'),
      })),
    });
    expect(res.body.slots).toHaveLength(35);
  });

  it('AC-33 bay 1 the only bay, booked 09:00 to 10:00 by T2: 28 starts, touching edges stay', async () => {
    const { place, world } = await north({ bays: 1 });
    await world.existing({
      place,
      bay: place.bays[0]!,
      technician: place.technicians[1]!,
      start: new Date('2027-03-09T09:00:00Z'),
      end: new Date('2027-03-09T10:00:00Z'),
    });

    const res = await oilAt(place, '2027-03-09').expect(200);

    const gone = every15('2027-03-09T08:15:00Z', '2027-03-09T09:45:00Z');
    expect(startsOf(res)).toHaveLength(28);
    expect(startsOf(res)).toEqual(
      every15('2027-03-09T08:00:00Z', '2027-03-09T16:30:00Z').filter((s) => !gone.includes(s)),
    );
    expect(startsOf(res)).toContain('2027-03-09T08:00:00Z');
    expect(startsOf(res)).toContain('2027-03-09T10:00:00Z');
  });

  it('AC-33 Mon 29 March (BST): 35 starts from 07:00Z to 15:30Z, local times at +01:00', async () => {
    const { place } = await north();

    const res = await oilAt(place, '2027-03-29').expect(200);

    expect(startsOf(res)).toEqual(every15('2027-03-29T07:00:00Z', '2027-03-29T15:30:00Z'));
    expect(res.body.slots[0]).toEqual({
      startsAt: '2027-03-29T07:00:00Z',
      startsAtLocal: '2027-03-29T08:00:00+01:00',
    });
    expect(res.body.slots[34]).toEqual({
      startsAt: '2027-03-29T15:30:00Z',
      startsAtLocal: '2027-03-29T16:30:00+01:00',
    });
  });

  it.each([
    ['2027-03-14', 'Sunday, closed'],
    ['2027-02-28', 'in the past'],
    ['2027-06-01', 'past the 90 day window'],
  ])('AC-33 %s (%s) is 200 with an empty list', async (date) => {
    const { place } = await north();

    const res = await oilAt(place, date).expect(200);

    expect(res.body).toEqual({
      dealershipId: place.id,
      serviceTypeId: types.oil,
      date,
      timeZone: 'Europe/London',
      slots: [],
    });
  });

  describe('which rows count', () => {
    it('AC-33 a cancelled row holds nothing', async () => {
      const { place, world } = await north({ bays: 1, technicians: [['OIL_SERVICE']] });
      await world.existing({
        place,
        bay: place.bays[0]!,
        technician: place.technicians[0]!,
        start: new Date('2027-03-09T09:00:00Z'),
        end: new Date('2027-03-09T10:00:00Z'),
        status: 'cancelled',
      });

      const res = await oilAt(place, '2027-03-09').expect(200);

      expect(startsOf(res)).toEqual(every15('2027-03-09T08:00:00Z', '2027-03-09T16:30:00Z'));
    });

    // T1 is the only OIL technician and is busy 09:00 to 10:00 on bay 2. T2
    // has only BRAKES and is free, but can't do an oil service. Bay 1 is free
    // the whole time, so only the technician can be the reason.
    it('AC-33 a free technician without the skill does not count', async () => {
      const { place, world } = await north({ bays: 2, technicians: [['OIL_SERVICE'], ['BRAKES']] });
      await world.existing({
        place,
        bay: place.bays[1]!,
        technician: place.technicians[0]!,
        start: new Date('2027-03-09T09:00:00Z'),
        end: new Date('2027-03-09T10:00:00Z'),
      });

      const res = await oilAt(place, '2027-03-09').expect(200);

      const gone = every15('2027-03-09T08:15:00Z', '2027-03-09T09:45:00Z');
      expect(startsOf(res)).toEqual(
        every15('2027-03-09T08:00:00Z', '2027-03-09T16:30:00Z').filter((s) => !gone.includes(s)),
      );
    });

    // A booking at another dealership at the same time doesn't touch North.
    it('AC-33 bookings at another dealership do not count', async () => {
      const { place, world } = await north({ bays: 1, technicians: [['OIL_SERVICE']] });
      const elsewhere = await world.place(OTHER, {
        name: 'Elsewhere',
        bays: 1,
        technicians: [['OIL_SERVICE']],
      });
      await world.existing({
        place: elsewhere,
        bay: elsewhere.bays[0]!,
        technician: elsewhere.technicians[0]!,
        start: new Date('2027-03-09T09:00:00Z'),
        end: new Date('2027-03-09T10:00:00Z'),
      });

      const res = await oilAt(place, '2027-03-09').expect(200);

      expect(startsOf(res)).toHaveLength(35);
    });

    // The date is Harbour's local date. Monday 8 March in Sydney (+11:00)
    // starts at 2027-03-07T13:00Z, so the first slot and the booking that
    // blocks it are on the UTC date before. A day query on the UTC date
    // would miss the booking and show 21:00Z as free.
    it('AC-33 Harbour (Sydney): the day is the local day, bookings on the UTC day before count', async () => {
      const world = newWorld(testDb.db, types);
      const harbour = await world.place(OTHER, {
        name: 'Harbour',
        timeZone: 'Australia/Sydney',
        hours: HARBOUR_HOURS,
        bays: 1,
        technicians: [['OIL_SERVICE']],
      });
      await world.existing({
        place: harbour,
        bay: harbour.bays[0]!,
        technician: harbour.technicians[0]!,
        start: new Date('2027-03-07T21:00:00Z'),
        end: new Date('2027-03-07T22:00:00Z'),
      });

      const res = await oilAt(harbour, '2027-03-08').expect(200);

      expect(res.body.timeZone).toBe('Australia/Sydney');
      expect(startsOf(res)).toEqual(every15('2027-03-07T22:00:00Z', '2027-03-08T05:00:00Z'));
      expect(res.body.slots[0]).toEqual({
        startsAt: '2027-03-07T22:00:00Z',
        startsAtLocal: '2027-03-08T09:00:00+11:00',
      });
    });
  });

  describe('unknown ids are 404', () => {
    it('AC-33 an unknown dealership is 404 DEALERSHIP_NOT_FOUND', async () => {
      const res = await availability({
        dealershipId: randomUUID(),
        serviceTypeId: types.oil,
        date: '2027-03-09',
      });
      expectProblem(res, 404, 'DEALERSHIP_NOT_FOUND');
    });

    it('AC-33 an unknown service type is 404 SERVICE_TYPE_NOT_FOUND', async () => {
      const { place } = await north();
      const res = await availability({
        dealershipId: place.id,
        serviceTypeId: randomUUID(),
        date: '2027-03-09',
      });
      expectProblem(res, 404, 'SERVICE_TYPE_NOT_FOUND');
    });

    // Same order as booking (SPEC "Order of checks"): the dealership first
    it('AC-33 both unknown is 404 DEALERSHIP_NOT_FOUND', async () => {
      const res = await availability({
        dealershipId: randomUUID(),
        serviceTypeId: randomUUID(),
        date: '2027-03-09',
      });
      expectProblem(res, 404, 'DEALERSHIP_NOT_FOUND');
    });
  });

  describe('a bad query is 400 VALIDATION_FAILED naming the field', () => {
    it.each(['2027-3-9', 'tomorrow', '2027-02-30', '2027-03-09T09:00:00Z', '20270309', ''])(
      'AC-33 date=%s',
      async (date) => {
        const { place } = await north();
        const res = await oilAt(place, date);
        expectProblem(res, 400, 'VALIDATION_FAILED');
        expect(errorFields(res)).toEqual(['date']);
      },
    );

    it.each(['dealershipId', 'serviceTypeId', 'date'])('AC-33 a missing %s', async (field) => {
      const { place } = await north();
      const query: Record<string, string> = {
        dealershipId: place.id,
        serviceTypeId: types.oil,
        date: '2027-03-09',
      };
      delete query[field];
      const res = await availability(query);
      expectProblem(res, 400, 'VALIDATION_FAILED');
      expect(errorFields(res)).toEqual([field]);
    });

    it.each(['dealershipId', 'serviceTypeId'])('AC-33 a %s that is not a UUID', async (field) => {
      const { place } = await north();
      const res = await availability({
        dealershipId: place.id,
        serviceTypeId: types.oil,
        date: '2027-03-09',
        [field]: 'abc',
      });
      expectProblem(res, 400, 'VALIDATION_FAILED');
      expect(errorFields(res)).toEqual([field]);
    });

    // Validation runs before any lookup, so a bad date wins over an unknown id
    it('AC-33 a bad date with an unknown dealership is 400, not 404', async () => {
      const res = await availability({
        dealershipId: randomUUID(),
        serviceTypeId: types.oil,
        date: 'tomorrow',
      });
      expectProblem(res, 400, 'VALIDATION_FAILED');
      expect(errorFields(res)).toEqual(['date']);
    });
  });

  it('AC-32 GET /docs-json lists /availability with 200, 400 and 404', async () => {
    const res = await http().get('/docs-json').expect(200);
    const paths = res.body.paths as Record<string, Record<string, { responses: object }>>;

    const get = paths['/availability']?.get;
    expect(Object.keys(get?.responses ?? {}).sort()).toEqual(['200', '400', '404'].sort());
  });
});
