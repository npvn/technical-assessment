import { sql } from 'kysely';
import {
  insertAppointment,
  insertBay,
  insertCustomerWithVehicle,
  insertDealership,
  insertServiceType,
  insertTechnician,
  type AppointmentRowInput,
} from '../support/fixtures.js';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';

// AC-21: the database itself refuses bad rows, even when they come in as raw
// inserts that skip the booking service. Each case is built so exactly one
// rule can refuse the row (the second row shares only the resource under
// test, and so on). That way the SQLSTATE and the constraint name prove which
// rule did the work.

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase();
});

afterAll(async () => {
  await tdb?.destroy();
});

// Every test builds its own dealerships, bays, technicians and vehicles, so
// rows left behind by one test can never get in the way of another.
async function buildWorld() {
  const { db } = tdb;
  const north = await insertDealership(db, { name: 'North' });
  const south = await insertDealership(db, { name: 'South' });
  const bay1 = await insertBay(db, { dealershipId: north, name: 'Bay 1' });
  const bay2 = await insertBay(db, { dealershipId: north, name: 'Bay 2' });
  const t1 = await insertTechnician(db, { dealershipId: north, name: 'T1' });
  const t2 = await insertTechnician(db, { dealershipId: north, name: 'T2' });
  const southBay = await insertBay(db, { dealershipId: south, name: 'South bay' });
  const southTech = await insertTechnician(db, { dealershipId: south, name: 'South tech' });
  const oil = await insertServiceType(db, { durationMinutes: 60, requiredSkill: 'OIL_SERVICE' });
  const c1 = await insertCustomerWithVehicle(db);
  const c2 = await insertCustomerWithVehicle(db);

  // A row at North, 09:00 to 10:00 on Tue 9 March 2027, bay 1, T1, c1's car.
  // Overrides change only what a case needs.
  const row = (overrides: Partial<AppointmentRowInput> = {}): AppointmentRowInput => ({
    dealershipId: north,
    serviceTypeId: oil,
    customerId: c1.customerId,
    vehicleId: c1.vehicleId,
    serviceBayId: bay1,
    technicianId: t1,
    startsAt: '2027-03-09T09:00:00Z',
    endsAt: '2027-03-09T10:00:00Z',
    ...overrides,
  });

  return { north, south, bay1, bay2, t1, t2, southBay, southTech, oil, c1, c2, row };
}

// pg errors carry the SQLSTATE in `code` and the constraint (or index) name
// in `constraint`. Kysely passes them through unchanged.
async function expectRefused(
  work: Promise<unknown>,
  code: string,
  constraint: string,
): Promise<void> {
  await expect(work).rejects.toMatchObject({ code, constraint });
}

async function countAppointments(where: { customerId: string }): Promise<number> {
  const result = await tdb.db
    .selectFrom('appointments')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('customer_id', '=', where.customerId)
    .executeTakeFirstOrThrow();
  return Number(result.n);
}

describe('AC-21 overlapping rows', () => {
  it('AC-21 an overlapping row on the same bay is refused (23P01 appointments_no_bay_overlap)', async () => {
    const w = await buildWorld();
    await insertAppointment(tdb.db, w.row());

    // Same bay, different technician and vehicle, 09:30 to 10:30
    await expectRefused(
      insertAppointment(
        tdb.db,
        w.row({
          technicianId: w.t2,
          customerId: w.c2.customerId,
          vehicleId: w.c2.vehicleId,
          startsAt: '2027-03-09T09:30:00Z',
          endsAt: '2027-03-09T10:30:00Z',
        }),
      ),
      '23P01',
      'appointments_no_bay_overlap',
    );
  });

  it('AC-21 an overlapping row on the same technician is refused (23P01 appointments_no_technician_overlap)', async () => {
    const w = await buildWorld();
    await insertAppointment(tdb.db, w.row());

    // Same technician, different bay and vehicle, 08:30 to 09:30
    await expectRefused(
      insertAppointment(
        tdb.db,
        w.row({
          serviceBayId: w.bay2,
          customerId: w.c2.customerId,
          vehicleId: w.c2.vehicleId,
          startsAt: '2027-03-09T08:30:00Z',
          endsAt: '2027-03-09T09:30:00Z',
        }),
      ),
      '23P01',
      'appointments_no_technician_overlap',
    );
  });

  it('AC-21 an overlapping row on the same vehicle is refused, even at another dealership (23P01 appointments_no_vehicle_overlap)', async () => {
    const w = await buildWorld();
    await insertAppointment(tdb.db, w.row());

    // Same vehicle at South, on South's bay and technician, 09:15 to 09:45
    await expectRefused(
      insertAppointment(
        tdb.db,
        w.row({
          dealershipId: w.south,
          serviceBayId: w.southBay,
          technicianId: w.southTech,
          startsAt: '2027-03-09T09:15:00Z',
          endsAt: '2027-03-09T09:45:00Z',
        }),
      ),
      '23P01',
      'appointments_no_vehicle_overlap',
    );
  });

  it('AC-21 touching rows on the same bay, technician and vehicle are accepted (half open ranges)', async () => {
    const w = await buildWorld();
    await insertAppointment(tdb.db, w.row());
    await insertAppointment(
      tdb.db,
      w.row({ startsAt: '2027-03-09T10:00:00Z', endsAt: '2027-03-09T11:00:00Z' }),
    );
    await insertAppointment(
      tdb.db,
      w.row({ startsAt: '2027-03-09T08:00:00Z', endsAt: '2027-03-09T09:00:00Z' }),
    );

    expect(await countAppointments({ customerId: w.c1.customerId })).toBe(3);
  });

  it('AC-21 rows overlapping a cancelled one are accepted, for bay, technician and vehicle', async () => {
    const w = await buildWorld();
    await insertAppointment(tdb.db, w.row({ status: 'cancelled' }));
    // Exactly the same bay, technician, vehicle and time, but the first is cancelled
    await insertAppointment(tdb.db, w.row());

    expect(await countAppointments({ customerId: w.c1.customerId })).toBe(2);
  });
});

describe('AC-21 resources from another dealership', () => {
  it('AC-21 a bay from another dealership is refused (23503 appointments_service_bay_fkey)', async () => {
    const w = await buildWorld();
    // The bay exists, it's just South's, so only the composite key can refuse it
    await expectRefused(
      insertAppointment(tdb.db, w.row({ serviceBayId: w.southBay })),
      '23503',
      'appointments_service_bay_fkey',
    );
  });

  it('AC-21 a technician from another dealership is refused (23503 appointments_technician_fkey)', async () => {
    const w = await buildWorld();
    await expectRefused(
      insertAppointment(tdb.db, w.row({ technicianId: w.southTech })),
      '23503',
      'appointments_technician_fkey',
    );
  });
});

describe('AC-21 empty and backwards ranges', () => {
  it('AC-21 ends_at equal to starts_at is refused (23514 appointments_ends_after_starts)', async () => {
    const w = await buildWorld();
    await expectRefused(
      insertAppointment(
        tdb.db,
        w.row({ startsAt: '2027-03-09T09:00:00Z', endsAt: '2027-03-09T09:00:00Z' }),
      ),
      '23514',
      'appointments_ends_after_starts',
    );
  });

  it('AC-21 ends_at before starts_at is refused (23514 appointments_ends_after_starts)', async () => {
    const w = await buildWorld();
    await expectRefused(
      insertAppointment(
        tdb.db,
        w.row({ startsAt: '2027-03-09T10:00:00Z', endsAt: '2027-03-09T09:00:00Z' }),
      ),
      '23514',
      'appointments_ends_after_starts',
    );
  });
});

describe('AC-21 service type duration', () => {
  it('AC-21 a service type with duration_minutes 0 is refused (23514 service_types_duration_minutes_check)', async () => {
    await expectRefused(
      insertServiceType(tdb.db, { durationMinutes: 0 }),
      '23514',
      'service_types_duration_minutes_check',
    );
  });
});

describe('AC-21 deleting things that have an appointment', () => {
  it('AC-21 deleting a bay with an appointment is refused (23503 appointments_service_bay_fkey)', async () => {
    const w = await buildWorld();
    await insertAppointment(tdb.db, w.row());
    await expectRefused(
      tdb.db.deleteFrom('service_bays').where('id', '=', w.bay1).execute(),
      '23503',
      'appointments_service_bay_fkey',
    );
  });

  it('AC-21 deleting a technician with an appointment is refused (23503 appointments_technician_fkey)', async () => {
    const w = await buildWorld();
    // No skills, so technician_skills can't be the thing that refuses the delete
    const noSkills = await insertTechnician(tdb.db, { dealershipId: w.north, skills: [] });
    await insertAppointment(tdb.db, w.row({ technicianId: noSkills }));
    await expectRefused(
      tdb.db.deleteFrom('technicians').where('id', '=', noSkills).execute(),
      '23503',
      'appointments_technician_fkey',
    );
  });

  it('AC-21 deleting a vehicle with an appointment is refused (23503 appointments_vehicle_id_fkey)', async () => {
    const w = await buildWorld();
    await insertAppointment(tdb.db, w.row());
    await expectRefused(
      tdb.db.deleteFrom('vehicles').where('id', '=', w.c1.vehicleId).execute(),
      '23503',
      'appointments_vehicle_id_fkey',
    );
  });

  it('AC-21 deleting a customer with an appointment is refused (23503 appointments_customer_id_fkey)', async () => {
    const w = await buildWorld();
    await insertAppointment(tdb.db, w.row());
    // c1 sells the car to c2 after booking (the schema allows that on purpose,
    // ADR 001). Now c1 owns no vehicle, so only the appointment can refuse it.
    await tdb.db
      .updateTable('vehicles')
      .set({ customer_id: w.c2.customerId })
      .where('id', '=', w.c1.vehicleId)
      .execute();
    await expectRefused(
      tdb.db.deleteFrom('customers').where('id', '=', w.c1.customerId).execute(),
      '23503',
      'appointments_customer_id_fkey',
    );
  });
});

describe('AC-21 idempotency keys', () => {
  it('AC-21 two rows with the same customer and the same idempotency key are refused (23505 appointments_customer_idempotency_key_unique)', async () => {
    const w = await buildWorld();
    await insertAppointment(tdb.db, w.row({ idempotencyKey: 'key-1', requestHash: 'hash-a' }));
    // Different time, so no overlap rule can get there first
    await expectRefused(
      insertAppointment(
        tdb.db,
        w.row({
          idempotencyKey: 'key-1',
          requestHash: 'hash-b',
          startsAt: '2027-03-09T11:00:00Z',
          endsAt: '2027-03-09T12:00:00Z',
        }),
      ),
      '23505',
      'appointments_customer_idempotency_key_unique',
    );
  });

  it('AC-21 the same idempotency key for two different customers is accepted', async () => {
    const w = await buildWorld();
    await insertAppointment(tdb.db, w.row({ idempotencyKey: 'shared-key', requestHash: 'hash-a' }));
    await insertAppointment(
      tdb.db,
      w.row({
        customerId: w.c2.customerId,
        vehicleId: w.c2.vehicleId,
        serviceBayId: w.bay2,
        technicianId: w.t2,
        idempotencyKey: 'shared-key',
        requestHash: 'hash-b',
      }),
    );

    expect(await countAppointments({ customerId: w.c1.customerId })).toBe(1);
    expect(await countAppointments({ customerId: w.c2.customerId })).toBe(1);
  });

  it('AC-21 any number of rows with no idempotency key are accepted', async () => {
    const w = await buildWorld();
    for (const hour of ['09', '10', '11']) {
      await insertAppointment(
        tdb.db,
        w.row({ startsAt: `2027-03-09T${hour}:00:00Z`, endsAt: `2027-03-09T${hour}:30:00Z` }),
      );
    }

    expect(await countAppointments({ customerId: w.c1.customerId })).toBe(3);
  });
});

// Not in the AC-21 table, but they are rules the step 2 notes put into the
// schema, so each one gets a test that proves it is really there.
describe('other schema checks from the step 2 notes', () => {
  it('a status other than confirmed or cancelled is refused (23514 appointments_status_check)', async () => {
    const w = await buildWorld();
    // The status type only allows the two values, so this one goes in as raw SQL
    const r = w.row();
    await expectRefused(
      sql`INSERT INTO appointments
            (dealership_id, service_type_id, customer_id, vehicle_id, service_bay_id, technician_id, starts_at, ends_at, status)
          VALUES (${r.dealershipId}, ${r.serviceTypeId}, ${r.customerId}, ${r.vehicleId}, ${r.serviceBayId},
                  ${r.technicianId}, ${r.startsAt}, ${r.endsAt}, 'pending')`.execute(tdb.db),
      '23514',
      'appointments_status_check',
    );
  });

  it('an idempotency key without a request hash is refused, and the other way round (23514 appointments_idempotency_pair_check)', async () => {
    const w = await buildWorld();
    await expectRefused(
      insertAppointment(tdb.db, w.row({ idempotencyKey: 'key-only', requestHash: null })),
      '23514',
      'appointments_idempotency_pair_check',
    );
    await expectRefused(
      insertAppointment(tdb.db, w.row({ idempotencyKey: null, requestHash: 'hash-only' })),
      '23514',
      'appointments_idempotency_pair_check',
    );
  });

  it('a service type longer than 600 minutes is refused (23514 service_types_duration_minutes_check)', async () => {
    await expectRefused(
      insertServiceType(tdb.db, { durationMinutes: 601 }),
      '23514',
      'service_types_duration_minutes_check',
    );
  });

  it('opening hours with a weekday outside 1 to 7 are refused (23514 opening_hours_iso_weekday_check)', async () => {
    await expectRefused(
      insertDealership(tdb.db, { hours: [{ isoWeekday: 0, opens: '08:00', closes: '17:00' }] }),
      '23514',
      'opening_hours_iso_weekday_check',
    );
    await expectRefused(
      insertDealership(tdb.db, { hours: [{ isoWeekday: 8, opens: '08:00', closes: '17:00' }] }),
      '23514',
      'opening_hours_iso_weekday_check',
    );
  });

  it('opening hours that close before or when they open are refused (23514 opening_hours_opens_before_closes)', async () => {
    await expectRefused(
      insertDealership(tdb.db, { hours: [{ isoWeekday: 1, opens: '17:00', closes: '08:00' }] }),
      '23514',
      'opening_hours_opens_before_closes',
    );
    await expectRefused(
      insertDealership(tdb.db, { hours: [{ isoWeekday: 1, opens: '08:00', closes: '08:00' }] }),
      '23514',
      'opening_hours_opens_before_closes',
    );
  });
});

// No service is longer than 600 minutes (the CHECK on service_types), and
// 0003 says the same about the rows themselves. The availability day query
// leans on it for its lower bound on starts_at, so a longer raw row (from
// psql, a script, a future multi day job) would be missed there.
describe('appointment length', () => {
  it('a row longer than 600 minutes is refused (23514 appointments_at_most_600_minutes)', async () => {
    const w = await buildWorld();
    await expectRefused(
      insertAppointment(
        tdb.db,
        w.row({ startsAt: '2027-03-09T08:00:00Z', endsAt: '2027-03-09T18:01:00Z' }),
      ),
      '23514',
      'appointments_at_most_600_minutes',
    );
  });

  it('a row of exactly 600 minutes is accepted', async () => {
    const w = await buildWorld();
    await insertAppointment(
      tdb.db,
      w.row({ startsAt: '2027-03-09T08:00:00Z', endsAt: '2027-03-09T18:00:00Z' }),
    );
    expect(await countAppointments({ customerId: w.c1.customerId })).toBe(1);
  });
});
