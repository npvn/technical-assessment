import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { AppointmentStatus, Database } from '../../src/db/types.js';

// Small builders for test data. Each one takes readable overrides, fills in
// the rest with something valid and unique, and returns the ids. They write
// rows straight into the tables, nothing goes through the booking service.

type Db = Kysely<Database>;

export interface DayHours {
  // 1 is Monday, 7 is Sunday
  isoWeekday: number;
  opens: string;
  closes: string;
}

// North's hours from the spec: Monday to Friday 08:00 to 17:30, Saturday
// 09:00 to 13:00, closed on Sunday (no row).
export const NORTH_HOURS: DayHours[] = [
  ...[1, 2, 3, 4, 5].map((isoWeekday) => ({ isoWeekday, opens: '08:00', closes: '17:30' })),
  { isoWeekday: 6, opens: '09:00', closes: '13:00' },
];

export async function insertDealership(
  db: Db,
  overrides: { id?: string; name?: string; timeZone?: string; hours?: DayHours[] } = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await db
    .insertInto('dealerships')
    .values({
      id,
      name: overrides.name ?? `Dealership ${id.slice(0, 8)}`,
      time_zone: overrides.timeZone ?? 'Europe/London',
    })
    .execute();
  const hours = overrides.hours ?? NORTH_HOURS;
  if (hours.length > 0) {
    await db
      .insertInto('opening_hours')
      .values(
        hours.map((h) => ({
          dealership_id: id,
          iso_weekday: h.isoWeekday,
          opens_at: h.opens,
          closes_at: h.closes,
        })),
      )
      .execute();
  }
  return id;
}

export async function insertBay(
  db: Db,
  overrides: { dealershipId: string; id?: string; name?: string },
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await db
    .insertInto('service_bays')
    .values({
      id,
      dealership_id: overrides.dealershipId,
      name: overrides.name ?? `Bay ${id.slice(0, 8)}`,
    })
    .execute();
  return id;
}

// Skills are a shared lookup table, so this adds the ones that are missing.
export async function ensureSkills(db: Db, codes: string[]): Promise<void> {
  if (codes.length === 0) {
    return;
  }
  await db
    .insertInto('skills')
    .values(codes.map((code) => ({ code, name: code })))
    .onConflict((oc) => oc.column('code').doNothing())
    .execute();
}

export async function insertTechnician(
  db: Db,
  overrides: { dealershipId: string; id?: string; name?: string; skills?: string[] },
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const skills = overrides.skills ?? ['OIL_SERVICE'];
  await db
    .insertInto('technicians')
    .values({
      id,
      dealership_id: overrides.dealershipId,
      name: overrides.name ?? `Tech ${id.slice(0, 8)}`,
    })
    .execute();
  await ensureSkills(db, skills);
  if (skills.length > 0) {
    await db
      .insertInto('technician_skills')
      .values(skills.map((skill_code) => ({ technician_id: id, skill_code })))
      .execute();
  }
  return id;
}

export async function insertServiceType(
  db: Db,
  overrides: {
    id?: string;
    code?: string;
    name?: string;
    durationMinutes?: number;
    requiredSkill?: string;
  } = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const skill = overrides.requiredSkill ?? 'OIL_SERVICE';
  await ensureSkills(db, [skill]);
  // code is unique across the catalogue, so the default has to be unique too
  const code = overrides.code ?? `SVC_${id.slice(0, 8).toUpperCase()}`;
  await db
    .insertInto('service_types')
    .values({
      id,
      code,
      name: overrides.name ?? code,
      duration_minutes: overrides.durationMinutes ?? 60,
      required_skill_code: skill,
    })
    .execute();
  return id;
}

// A made up VIN that is 17 characters and unique enough for tests.
function fakeVin(): string {
  return `TEST${randomUUID().replace(/-/g, '').slice(0, 13).toUpperCase()}`;
}

export async function insertCustomerWithVehicle(
  db: Db,
  overrides: {
    customerId?: string;
    vehicleId?: string;
    name?: string;
    email?: string;
    vin?: string;
  } = {},
): Promise<{ customerId: string; vehicleId: string }> {
  const customerId = overrides.customerId ?? randomUUID();
  const vehicleId = overrides.vehicleId ?? randomUUID();
  await db
    .insertInto('customers')
    .values({
      id: customerId,
      name: overrides.name ?? 'Test Customer',
      email: overrides.email ?? `${customerId}@example.test`,
    })
    .execute();
  await db
    .insertInto('vehicles')
    .values({
      id: vehicleId,
      customer_id: customerId,
      vin: overrides.vin ?? fakeVin(),
      make: 'Testmake',
      model: 'Testmodel',
      year: 2020,
    })
    .execute();
  return { customerId, vehicleId };
}

export interface AppointmentRowInput {
  id?: string;
  dealershipId: string;
  serviceTypeId: string;
  customerId: string;
  vehicleId: string;
  serviceBayId: string;
  technicianId: string;
  // ISO strings with an offset, or Dates
  startsAt: string | Date;
  endsAt: string | Date;
  status?: AppointmentStatus;
  idempotencyKey?: string | null;
  requestHash?: string | null;
}

// A raw appointment row, straight into the table. This is how tests set up
// existing bookings and how the schema tests try to sneak bad rows past the
// database.
export async function insertAppointment(db: Db, row: AppointmentRowInput): Promise<string> {
  const id = row.id ?? randomUUID();
  await db
    .insertInto('appointments')
    .values({
      id,
      dealership_id: row.dealershipId,
      service_type_id: row.serviceTypeId,
      customer_id: row.customerId,
      vehicle_id: row.vehicleId,
      service_bay_id: row.serviceBayId,
      technician_id: row.technicianId,
      starts_at: row.startsAt,
      ends_at: row.endsAt,
      status: row.status ?? 'confirmed',
      idempotency_key: row.idempotencyKey ?? null,
      request_hash: row.requestHash ?? null,
    })
    .execute();
  return id;
}
