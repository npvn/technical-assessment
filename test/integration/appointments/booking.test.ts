import { randomUUID } from 'node:crypto';
import type { BookingService } from '../../../src/appointments/booking.service.js';
import type {
  Appointment,
  BookingErrorCode,
  BookingResult,
} from '../../../src/appointments/booking.types.js';
import { createTestDatabase, type TestDatabase } from '../../support/test-database.js';
import { insertServiceType } from '../../support/fixtures.js';
import {
  HARBOUR_HOURS,
  NORTH,
  OTHER,
  RHINE_HOURS,
  SOUTH,
  ask,
  bookingService,
  countRows,
  insertServiceTypes,
  newWorld,
  tue,
  type Place,
  type ServiceTypes,
} from './world.js';

// The booking service on a real Postgres, one request at a time. These assert
// the domain result (the appointment, or the error code), not HTTP status
// codes. Mapping to 201, 404, 409 and 422 is step 5's job, and so are the
// cases that need HTTP (AC-37's 400 row, AC-44's GET half).

let tdb: TestDatabase;
let types: ServiceTypes;
let service: BookingService;

beforeAll(async () => {
  tdb = await createTestDatabase();
  types = await insertServiceTypes(tdb.db);
  service = bookingService(tdb.db);
});

afterAll(async () => {
  await tdb?.destroy();
});

const OIL = ['OIL_SERVICE'];

function world() {
  return newWorld(tdb.db, types);
}

function createdAppointment(result: BookingResult): Appointment {
  expect(result.kind).toBe('created');
  if (result.kind !== 'created') throw new Error('not created');
  return result.appointment;
}

function expectCreatedOn(result: BookingResult, bay: string, technician: string): void {
  expect(result).toMatchObject({
    kind: 'created',
    appointment: { serviceBayId: bay, technicianId: technician },
  });
}

function expectRejected(result: BookingResult, code: BookingErrorCode): void {
  expect(result).toEqual({ kind: 'rejected', code });
}

// A North with the given bays and technicians, and a car to book with.
async function north(bays: number, technicians: string[][]) {
  const w = world();
  const place = await w.place(NORTH, { name: 'North', bays, technicians });
  const car = await w.car();
  return { w, place, car };
}

describe('Booking', () => {
  it('AC-01 OIL at 09:00 with bays 1 and 2 and T1 free: created on bay 1 with T1, and the row matches', async () => {
    const { place, car } = await north(2, [OIL]);

    const result = await service.book(ask(types, place, car, tue('09:00')));

    // objectContaining, so a field added later (the time zone for the
    // response in step 5, say) doesn't break this test.
    expect(result).toEqual({
      kind: 'created',
      appointment: expect.objectContaining({
        id: expect.any(String),
        status: 'confirmed',
        dealershipId: place.id,
        serviceTypeId: types.oil,
        customerId: car.customerId,
        vehicleId: car.vehicleId,
        serviceBayId: place.bays[0],
        technicianId: place.technicians[0],
        startsAt: tue('09:00'),
        endsAt: tue('10:00'),
        createdAt: expect.any(Date),
      }),
    });

    const appointment = createdAppointment(result);
    const row = await tdb.db
      .selectFrom('appointments')
      .selectAll()
      .where('id', '=', appointment.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      dealership_id: place.id,
      service_type_id: types.oil,
      customer_id: car.customerId,
      vehicle_id: car.vehicleId,
      service_bay_id: place.bays[0],
      technician_id: place.technicians[0],
      starts_at: tue('09:00'),
      ends_at: tue('10:00'),
      status: 'confirmed',
    });
  });

  it('AC-02 only bay 1, booked 09:00 to 10:00 by T2: OIL at 10:00 is created on bay 1 (touching edges are fine)', async () => {
    const { w, place, car } = await north(1, [OIL, OIL]);
    const [bay1] = place.bays as [string];
    const [, t2] = place.technicians as [string, string];
    await w.existing({ place, bay: bay1, technician: t2, start: tue('09:00'), end: tue('10:00') });

    const result = await service.book(ask(types, place, car, tue('10:00')));

    expect(result).toMatchObject({ kind: 'created', appointment: { serviceBayId: bay1 } });
  });

  it('AC-03 bay 1 booked 09:00 to 10:00 by T2: OIL at 09:30 is created on bay 2 with T1', async () => {
    const { w, place, car } = await north(2, [OIL, OIL]);
    const [bay1, bay2] = place.bays as [string, string];
    const [t1, t2] = place.technicians as [string, string];
    await w.existing({ place, bay: bay1, technician: t2, start: tue('09:00'), end: tue('10:00') });

    expectCreatedOn(await service.book(ask(types, place, car, tue('09:30'))), bay2, t1);
  });

  it('AC-03 same setup with only bay 1 at the dealership: SLOT_UNAVAILABLE', async () => {
    const { w, place, car } = await north(1, [OIL, OIL]);
    const [bay1] = place.bays as [string];
    const [, t2] = place.technicians as [string, string];
    await w.existing({ place, bay: bay1, technician: t2, start: tue('09:00'), end: tue('10:00') });

    expectRejected(await service.book(ask(types, place, car, tue('09:30'))), 'SLOT_UNAVAILABLE');
  });

  it("AC-04 North's only OIL technician is busy: SLOT_UNAVAILABLE even with bay 1 free, and South's technician is never used", async () => {
    const w = world();
    // South's ids sort before North's, so a query that forgets the
    // dealership filter would pick South's bay and technician first.
    const south = await w.place(SOUTH, { name: 'South', bays: 1, technicians: [OIL] });
    const place = await w.place(NORTH, { name: 'North', bays: 2, technicians: [OIL] });
    const car = await w.car();
    const [, bay2] = place.bays as [string, string];
    const [t1] = place.technicians as [string];
    expect(south.bays[0]! < place.bays[0]!).toBe(true);
    expect(south.technicians[0]! < t1).toBe(true);
    // A raw row that isn't an OIL job
    await w.existing({
      place,
      bay: bay2,
      technician: t1,
      start: tue('09:00'),
      end: tue('11:00'),
      serviceTypeId: types.brakes,
    });

    expectRejected(await service.book(ask(types, place, car, tue('10:00'))), 'SLOT_UNAVAILABLE');
    expect(await countRows(tdb.db, { technicianId: south.technicians[0]! })).toBe(0);
  });

  it('AC-05 the only OIL technician is busy and T2 has only BRAKES: SLOT_UNAVAILABLE, T2 is never assigned', async () => {
    const { w, place, car } = await north(2, [OIL, ['BRAKES']]);
    const [, bay2] = place.bays as [string, string];
    const [t1, t2] = place.technicians as [string, string];
    await w.existing({ place, bay: bay2, technician: t1, start: tue('09:00'), end: tue('10:00') });

    expectRejected(await service.book(ask(types, place, car, tue('09:00'))), 'SLOT_UNAVAILABLE');
    expect(await countRows(tdb.db, { technicianId: t2 })).toBe(0);
  });

  it('AC-06 BRAKES at 10:00 for 90 minutes with T1 busy 10:30 to 11:30: created with T2 on bay 1 (the whole duration counts)', async () => {
    const { w, place, car } = await north(2, [['BRAKES'], ['BRAKES']]);
    const [bay1, bay2] = place.bays as [string, string];
    const [t1, t2] = place.technicians as [string, string];
    await w.existing({ place, bay: bay2, technician: t1, start: tue('10:30'), end: tue('11:30') });

    const result = await service.book(
      ask(types, place, car, tue('10:00'), { serviceTypeId: types.brakes }),
    );

    expectCreatedOn(result, bay1, t2);
    expect(createdAppointment(result).endsAt).toEqual(tue('11:30'));
  });

  it('AC-07 only bay 1, booked 10:00 to 11:00 by T2: DIAG at 09:00 (contains it) and OIL at 10:15 (inside it) are both SLOT_UNAVAILABLE', async () => {
    const { w, place, car } = await north(1, [
      ['OIL_SERVICE', 'DIAG'],
      ['OIL_SERVICE', 'DIAG'],
    ]);
    const [bay1] = place.bays as [string];
    const [, t2] = place.technicians as [string, string];
    await w.existing({ place, bay: bay1, technician: t2, start: tue('10:00'), end: tue('11:00') });

    expectRejected(
      await service.book(ask(types, place, car, tue('09:00'), { serviceTypeId: types.diag })),
      'SLOT_UNAVAILABLE',
    );
    expectRejected(await service.book(ask(types, place, car, tue('10:15'))), 'SLOT_UNAVAILABLE');
  });

  it('AC-08 TA has OIL_SERVICE and BRAKES, TB has only OIL_SERVICE: OIL goes to TB (least flexible first)', async () => {
    const { place, car } = await north(1, [['OIL_SERVICE', 'BRAKES'], OIL]);
    const [bay1] = place.bays as [string];
    const [, tb] = place.technicians as [string, string];

    expectCreatedOn(await service.book(ask(types, place, car, tue('09:00'))), bay1, tb);
  });

  it('AC-08 T1 and T2 both have only OIL_SERVICE: OIL goes to T1 (equal skill count, lowest id)', async () => {
    const { place, car } = await north(1, [OIL, OIL]);
    const [bay1] = place.bays as [string];
    const [t1] = place.technicians as [string];

    expectCreatedOn(await service.book(ask(types, place, car, tue('09:00'))), bay1, t1);
  });

  it('AC-09 preferred T2, free: created with T2, not the T1 auto-assignment would pick', async () => {
    const { place, car } = await north(2, [OIL, OIL]);
    const [bay1] = place.bays as [string];
    const [, t2] = place.technicians as [string, string];

    const result = await service.book(
      ask(types, place, car, tue('09:00'), { preferredTechnicianId: t2 }),
    );

    expectCreatedOn(result, bay1, t2);
  });

  it('AC-09 preferred T2 booked 09:00 to 10:00 on bay 2, T1 free: TECHNICIAN_UNAVAILABLE, no fallback to T1', async () => {
    const { w, place, car } = await north(2, [OIL, OIL]);
    const [, bay2] = place.bays as [string, string];
    const [t1, t2] = place.technicians as [string, string];
    await w.existing({ place, bay: bay2, technician: t2, start: tue('09:00'), end: tue('10:00') });

    expectRejected(
      await service.book(ask(types, place, car, tue('09:00'), { preferredTechnicianId: t2 })),
      'TECHNICIAN_UNAVAILABLE',
    );
    expect(await countRows(tdb.db, { technicianId: t1 })).toBe(0);
  });

  it('AC-09 preferred technician who works at another dealership: TECHNICIAN_NOT_ELIGIBLE', async () => {
    const w = world();
    const south = await w.place(SOUTH, { name: 'South', bays: 1, technicians: [OIL] });
    const place = await w.place(NORTH, { name: 'North', bays: 2, technicians: [OIL, OIL] });
    const car = await w.car();

    expectRejected(
      await service.book(
        ask(types, place, car, tue('09:00'), { preferredTechnicianId: south.technicians[0]! }),
      ),
      'TECHNICIAN_NOT_ELIGIBLE',
    );
  });

  it('AC-09 preferred technician who lacks the skill: TECHNICIAN_NOT_ELIGIBLE', async () => {
    const { place, car } = await north(2, [OIL, ['BRAKES']]);
    const [, brakesOnly] = place.technicians as [string, string];

    expectRejected(
      await service.book(
        ask(types, place, car, tue('09:00'), { preferredTechnicianId: brakesOnly }),
      ),
      'TECHNICIAN_NOT_ELIGIBLE',
    );
  });

  it('AC-09 unknown preferred technician id: TECHNICIAN_NOT_FOUND', async () => {
    const { place, car } = await north(2, [OIL, OIL]);

    expectRejected(
      await service.book(
        ask(types, place, car, tue('09:00'), { preferredTechnicianId: randomUUID() }),
      ),
      'TECHNICIAN_NOT_FOUND',
    );
  });

  it('AC-10 the vehicle is booked at South 10:00 to 11:00: the same vehicle at North at 10:30 is VEHICLE_ALREADY_BOOKED', async () => {
    const w = world();
    const south = await w.place(SOUTH, { name: 'South', bays: 1, technicians: [OIL] });
    const place = await w.place(NORTH, { name: 'North', bays: 2, technicians: [OIL, OIL] });
    const car = await w.car();
    await w.existing({
      place: south,
      bay: south.bays[0]!,
      technician: south.technicians[0]!,
      start: tue('10:00'),
      end: tue('11:00'),
      car,
    });

    expectRejected(
      await service.book(ask(types, place, car, tue('10:30'))),
      'VEHICLE_ALREADY_BOOKED',
    );
  });

  it('AC-11 cancelled rows on bay 1, on T1 and for the requesting vehicle hold nothing: created on bay 1 with T1', async () => {
    const { w, place, car } = await north(1, [OIL]);
    const [bay1] = place.bays as [string];
    const [t1] = place.technicians as [string];
    // With one bay and one technician every row has to use both. Cancelled
    // rows can overlap each other, so all three sit at 09:00 to 10:00. The
    // third one is the requesting car's own cancelled booking.
    const cancelled = {
      place,
      bay: bay1,
      technician: t1,
      start: tue('09:00'),
      end: tue('10:00'),
      status: 'cancelled' as const,
    };
    await w.existing(cancelled);
    await w.existing(cancelled);
    await w.existing({ ...cancelled, car });

    expectCreatedOn(await service.book(ask(types, place, car, tue('09:00'))), bay1, t1);
  });

  it('AC-44 changing the service duration later does not move the stored end', async () => {
    const { place, car } = await north(2, [OIL]);
    // Its own OIL-like service type, so changing it can't affect other tests.
    const oil = await insertServiceType(tdb.db, {
      durationMinutes: 60,
      requiredSkill: 'OIL_SERVICE',
    });

    const appointment = createdAppointment(
      await service.book(ask(types, place, car, tue('09:00'), { serviceTypeId: oil })),
    );
    await tdb.db
      .updateTable('service_types')
      .set({ duration_minutes: 90 })
      .where('id', '=', oil)
      .execute();

    expect(appointment.endsAt).toEqual(new Date('2027-03-09T10:00:00Z'));
    const row = await tdb.db
      .selectFrom('appointments')
      .select('ends_at')
      .where('id', '=', appointment.id)
      .executeTakeFirstOrThrow();
    expect(row.ends_at).toEqual(new Date('2027-03-09T10:00:00Z'));
  });
});

// The pure rules are unit tested in step 1. These check that the service
// hands them the dealership's own zone and opening hours from the database.
describe('Time rules through the service', () => {
  it('AC-12 OIL Mon 8th at 16:30 ends exactly at closing: created', async () => {
    const { place, car } = await north(1, [OIL]);

    expect(
      await service.book(ask(types, place, car, new Date('2027-03-08T16:30:00Z'))),
    ).toMatchObject({
      kind: 'created',
    });
  });

  it('AC-12 Mon 17:00, Mon 07:45, Sun 14th 09:00 and Sat 13th 12:30: OUTSIDE_OPENING_HOURS', async () => {
    const { place, car } = await north(1, [OIL]);

    for (const iso of [
      '2027-03-08T17:00:00Z',
      '2027-03-08T07:45:00Z',
      '2027-03-14T09:00:00Z',
      '2027-03-13T12:30:00Z',
    ]) {
      expectRejected(
        await service.book(ask(types, place, car, new Date(iso))),
        'OUTSIDE_OPENING_HOURS',
      );
    }
  });

  it('AC-13 Harbour, 2027-03-08T08:00:00+11:00 (Sunday 21:00 UTC, Monday in Sydney): created', async () => {
    const w = world();
    const harbour = await w.place(OTHER, {
      name: 'Harbour',
      timeZone: 'Australia/Sydney',
      hours: HARBOUR_HOURS,
      bays: 1,
      technicians: [OIL],
    });
    const car = await w.car();

    const result = await service.book(
      ask(types, harbour, car, new Date('2027-03-08T08:00:00+11:00')),
    );

    expect(createdAppointment(result).startsAt).toEqual(new Date('2027-03-07T21:00:00Z'));
  });

  it('AC-13 Rhine opens 09:00 Berlin time: 08:30Z (09:30 in Berlin) is created, 08:30+01:00 is OUTSIDE_OPENING_HOURS', async () => {
    const w = world();
    const rhine = await w.place(OTHER, {
      name: 'Rhine',
      timeZone: 'Europe/Berlin',
      hours: RHINE_HOURS,
      bays: 1,
      technicians: [OIL],
    });
    const car = await w.car();

    expect(
      await service.book(ask(types, rhine, car, new Date('2027-03-09T08:30:00Z'))),
    ).toMatchObject({
      kind: 'created',
    });
    expectRejected(
      await service.book(ask(types, rhine, car, new Date('2027-03-09T08:30:00+01:00'))),
      'OUTSIDE_OPENING_HOURS',
    );
  });

  it('AC-14 Mon 29th after the change to BST: 07:00Z and 07:30Z are created, 06:30Z is OUTSIDE_OPENING_HOURS', async () => {
    // Two bays and two technicians, so 07:00 and 07:30 don't block each other.
    const { w, place } = await north(2, [OIL, OIL]);
    const first = await w.car();
    const second = await w.car();
    const third = await w.car();

    expect(
      await service.book(ask(types, place, first, new Date('2027-03-29T07:00:00Z'))),
    ).toMatchObject({
      kind: 'created',
    });
    expect(
      await service.book(ask(types, place, second, new Date('2027-03-29T07:30:00Z'))),
    ).toMatchObject({
      kind: 'created',
    });
    expectRejected(
      await service.book(ask(types, place, third, new Date('2027-03-29T06:30:00Z'))),
      'OUTSIDE_OPENING_HOURS',
    );
  });
});

describe('Lookups', () => {
  async function ready(): Promise<{
    place: Place;
    car: { customerId: string; vehicleId: string };
  }> {
    const { place, car } = await north(2, [OIL]);
    return { place, car };
  }

  it('AC-18 unknown dealership: DEALERSHIP_NOT_FOUND', async () => {
    const { place, car } = await ready();
    expectRejected(
      await service.book(ask(types, place, car, tue('09:00'), { dealershipId: randomUUID() })),
      'DEALERSHIP_NOT_FOUND',
    );
  });

  it('AC-18 unknown service type: SERVICE_TYPE_NOT_FOUND', async () => {
    const { place, car } = await ready();
    expectRejected(
      await service.book(ask(types, place, car, tue('09:00'), { serviceTypeId: randomUUID() })),
      'SERVICE_TYPE_NOT_FOUND',
    );
  });

  it('AC-18 unknown customer: CUSTOMER_NOT_FOUND', async () => {
    const { place, car } = await ready();
    expectRejected(
      await service.book(ask(types, place, car, tue('09:00'), { customerId: randomUUID() })),
      'CUSTOMER_NOT_FOUND',
    );
  });

  it('AC-18 unknown vehicle: VEHICLE_NOT_FOUND', async () => {
    const { place, car } = await ready();
    expectRejected(
      await service.book(ask(types, place, car, tue('09:00'), { vehicleId: randomUUID() })),
      'VEHICLE_NOT_FOUND',
    );
  });

  it('AC-18 the vehicle belongs to another customer: VEHICLE_NOT_OWNED_BY_CUSTOMER', async () => {
    const w = world();
    const { place, car } = await ready();
    const other = await w.car();
    expectRejected(
      await service.book(ask(types, place, car, tue('09:00'), { vehicleId: other.vehicleId })),
      'VEHICLE_NOT_OWNED_BY_CUSTOMER',
    );
  });

  it('AC-19 a dealership with no bays but an OIL_SERVICE technician: SERVICE_NOT_OFFERED', async () => {
    const { place, car } = await north(0, [OIL]);
    expectRejected(await service.book(ask(types, place, car, tue('09:00'))), 'SERVICE_NOT_OFFERED');
  });

  it('AC-19 a dealership with bays but no OIL_SERVICE technician: SERVICE_NOT_OFFERED', async () => {
    const { place, car } = await north(2, [['BRAKES']]);
    expectRejected(await service.book(ask(types, place, car, tue('09:00'))), 'SERVICE_NOT_OFFERED');
  });
});

// When a request breaks more than one rule, the first one in the SPEC
// "Order of checks" decides. Every case here breaks at least two.
describe('AC-37 order of checks', () => {
  it('AC-37 unknown dealership and unknown vehicle: DEALERSHIP_NOT_FOUND', async () => {
    const { place, car } = await north(1, [OIL]);
    expectRejected(
      await service.book(
        ask(types, place, car, tue('09:00'), {
          dealershipId: randomUUID(),
          vehicleId: randomUUID(),
        }),
      ),
      'DEALERSHIP_NOT_FOUND',
    );
  });

  it('AC-37 the 404s go dealership, service type, customer, vehicle, then technician', async () => {
    const { place, car } = await north(1, [OIL]);
    const unknown = {
      serviceTypeId: randomUUID(),
      customerId: randomUUID(),
      vehicleId: randomUUID(),
      preferredTechnicianId: randomUUID(),
    };
    const base = ask(types, place, car, tue('09:00'));

    expectRejected(await service.book({ ...base, ...unknown }), 'SERVICE_TYPE_NOT_FOUND');
    expectRejected(
      await service.book({ ...base, ...unknown, serviceTypeId: types.oil }),
      'CUSTOMER_NOT_FOUND',
    );
    expectRejected(
      await service.book({
        ...base,
        ...unknown,
        serviceTypeId: types.oil,
        customerId: car.customerId,
      }),
      'VEHICLE_NOT_FOUND',
    );
  });

  it('AC-37 unknown vehicle and unknown preferred technician: VEHICLE_NOT_FOUND', async () => {
    const { place, car } = await north(1, [OIL]);
    expectRejected(
      await service.book(
        ask(types, place, car, tue('09:00'), {
          vehicleId: randomUUID(),
          preferredTechnicianId: randomUUID(),
        }),
      ),
      'VEHICLE_NOT_FOUND',
    );
  });

  it('AC-37 the vehicle belongs to another customer and the preferred technician is unknown: TECHNICIAN_NOT_FOUND (404s before 422s)', async () => {
    const { w, place, car } = await north(1, [OIL]);
    const other = await w.car();
    expectRejected(
      await service.book(
        ask(types, place, car, tue('09:00'), {
          vehicleId: other.vehicleId,
          preferredTechnicianId: randomUUID(),
        }),
      ),
      'TECHNICIAN_NOT_FOUND',
    );
  });

  it('AC-37 the vehicle belongs to another customer and the start is off the grid (09:07): VEHICLE_NOT_OWNED_BY_CUSTOMER', async () => {
    const { w, place, car } = await north(1, [OIL]);
    const other = await w.car();
    expectRejected(
      await service.book(ask(types, place, car, tue('09:07'), { vehicleId: other.vehicleId })),
      'VEHICLE_NOT_OWNED_BY_CUSTOMER',
    );
  });

  it('AC-37 the preferred technician lacks the skill and the start is in the past: TECHNICIAN_NOT_ELIGIBLE', async () => {
    const { place, car } = await north(1, [OIL, ['BRAKES']]);
    const [, brakesOnly] = place.technicians as [string, string];
    expectRejected(
      await service.book(
        ask(types, place, car, new Date('2027-03-01T08:45:00Z'), {
          preferredTechnicianId: brakesOnly,
        }),
      ),
      'TECHNICIAN_NOT_ELIGIBLE',
    );
  });

  it('AC-37 the preferred technician is not eligible and the dealership has no bays: TECHNICIAN_NOT_ELIGIBLE before SERVICE_NOT_OFFERED', async () => {
    const { place, car } = await north(0, [['BRAKES']]);
    const [brakesOnly] = place.technicians as [string];
    expectRejected(
      await service.book(
        ask(types, place, car, tue('09:00'), { preferredTechnicianId: brakesOnly }),
      ),
      'TECHNICIAN_NOT_ELIGIBLE',
    );
  });

  it('AC-37 the dealership does not offer the service and the start is off the grid: SERVICE_NOT_OFFERED before the time rules', async () => {
    const { place, car } = await north(0, [OIL]);
    expectRejected(await service.book(ask(types, place, car, tue('09:07'))), 'SERVICE_NOT_OFFERED');
  });

  it('AC-37 off the grid and in the past (2027-03-01T08:07:00Z): START_NOT_ON_GRID', async () => {
    const { place, car } = await north(1, [OIL]);
    expectRejected(
      await service.book(ask(types, place, car, new Date('2027-03-01T08:07:00Z'))),
      'START_NOT_ON_GRID',
    );
  });

  it('AC-37 in the past and before opening (2027-03-01T07:45:00Z): START_IN_PAST', async () => {
    const { place, car } = await north(1, [OIL]);
    expectRejected(
      await service.book(ask(types, place, car, new Date('2027-03-01T07:45:00Z'))),
      'START_IN_PAST',
    );
  });

  it('AC-37 past the horizon and on a Sunday (2027-06-06T09:00:00Z): BEYOND_BOOKING_HORIZON', async () => {
    const { place, car } = await north(1, [OIL]);
    expectRejected(
      await service.book(ask(types, place, car, new Date('2027-06-06T09:00:00Z'))),
      'BEYOND_BOOKING_HORIZON',
    );
  });

  it("AC-37 the vehicle is booked at South at the same time and North's only bay is booked too: VEHICLE_ALREADY_BOOKED", async () => {
    const w = world();
    const south = await w.place(SOUTH, { name: 'South', bays: 1, technicians: [OIL] });
    const place = await w.place(NORTH, { name: 'North', bays: 1, technicians: [OIL, OIL] });
    const car = await w.car();
    const [bay1] = place.bays as [string];
    const [, t2] = place.technicians as [string, string];
    await w.existing({
      place: south,
      bay: south.bays[0]!,
      technician: south.technicians[0]!,
      start: tue('09:00'),
      end: tue('10:00'),
      car,
    });
    await w.existing({ place, bay: bay1, technician: t2, start: tue('09:00'), end: tue('10:00') });

    expectRejected(
      await service.book(ask(types, place, car, tue('09:00'))),
      'VEHICLE_ALREADY_BOOKED',
    );
  });

  it('AC-37 preferred T1 is busy and no bay is free: TECHNICIAN_UNAVAILABLE', async () => {
    // Both bays are taken at 09:00, one of them by T1.
    const { w, place, car } = await north(2, [OIL, OIL]);
    const [bay1, bay2] = place.bays as [string, string];
    const [t1, t2] = place.technicians as [string, string];
    await w.existing({ place, bay: bay1, technician: t2, start: tue('09:00'), end: tue('10:00') });
    await w.existing({ place, bay: bay2, technician: t1, start: tue('09:00'), end: tue('10:00') });

    expectRejected(
      await service.book(ask(types, place, car, tue('09:00'), { preferredTechnicianId: t1 })),
      'TECHNICIAN_UNAVAILABLE',
    );
  });

  it('AC-37 preferred T1 is free and no bay is free: SLOT_UNAVAILABLE', async () => {
    const { w, place, car } = await north(1, [OIL, OIL]);
    const [bay1] = place.bays as [string];
    const [t1, t2] = place.technicians as [string, string];
    await w.existing({ place, bay: bay1, technician: t2, start: tue('09:00'), end: tue('10:00') });

    expectRejected(
      await service.book(ask(types, place, car, tue('09:00'), { preferredTechnicianId: t1 })),
      'SLOT_UNAVAILABLE',
    );
  });
});
