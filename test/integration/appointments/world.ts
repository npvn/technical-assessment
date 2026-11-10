import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  DEFAULT_BOOKING_CONFIG,
  type BookingConfig,
} from '../../../src/appointments/booking.config.js';
import { BookingService } from '../../../src/appointments/booking.service.js';
import { PostgresBookingStore } from '../../../src/appointments/booking.store.js';
import type { BookingRequest, BookingResult } from '../../../src/appointments/booking.types.js';
import type { AppointmentStatus, Database } from '../../../src/db/types.js';
import { FixedClock } from '../../../src/scheduling/index.js';
import {
  NORTH_HOURS,
  insertAppointment,
  insertBay,
  insertCustomerWithVehicle,
  insertDealership,
  insertServiceType,
  insertTechnician,
  type DayHours,
} from '../../support/fixtures.js';

// Shared setup for the booking tests, as in docs/SPEC.md "Shared setup".

type Db = Kysely<Database>;

// "Now" for every booking test, a Monday.
export const NOW = new Date('2027-03-01T09:00:00Z');

// A time on Tue 9 March 2027, where most booking cases happen. London is on
// UTC that day, so the local time and the UTC time are the same.
export function tue(time: string): Date {
  return new Date(`2027-03-09T${time}:00Z`);
}

export const HARBOUR_HOURS: DayHours[] = [1, 2, 3, 4, 5, 6].map((isoWeekday) => ({
  isoWeekday,
  opens: '08:00',
  closes: '17:00',
}));

export const RHINE_HOURS: DayHours[] = [1, 2, 3, 4, 5].map((isoWeekday) => ({
  isoWeekday,
  opens: '09:00',
  closes: '17:00',
}));

export interface ServiceTypes {
  oil: string;
  brakes: string;
  diag: string;
}

// The SPEC's three service types. Codes are unique across the catalogue, so
// they get the fixture's random codes and each file makes its own.
export async function insertServiceTypes(db: Db): Promise<ServiceTypes> {
  return {
    oil: await insertServiceType(db, { durationMinutes: 60, requiredSkill: 'OIL_SERVICE' }),
    brakes: await insertServiceType(db, { durationMinutes: 90, requiredSkill: 'BRAKES' }),
    diag: await insertServiceType(db, { durationMinutes: 180, requiredSkill: 'DIAG' }),
  };
}

// The service on a real Postgres with the shared clock. Concurrency tests
// pass a generous loop budget so a slow machine doesn't give a 503.
export function bookingService(db: Db, config: Partial<BookingConfig> = {}): BookingService {
  const full = { ...DEFAULT_BOOKING_CONFIG, ...config };
  return new BookingService(new PostgresBookingStore(db, full), new FixedClock(NOW), full);
}

export interface Car {
  customerId: string;
  vehicleId: string;
}

export interface Place {
  id: string;
  // In id order, so bays[0] is "bay 1" and technicians[0] is "T1"
  bays: string[];
  technicians: string[];
}

export interface PlaceSpec {
  name: string;
  timeZone?: string;
  hours?: DayHours[];
  bays: number;
  // One entry per technician with their skills, in id order
  technicians: string[][];
}

// Where each place's ids start. South sorts before North, which AC-04 needs.
export const SOUTH = 1;
export const NORTH = 2;
export const OTHER = 3;

// One test's slice of the database. All tests in a file share one database,
// so the SPEC's fixed ids would clash between tests. Instead every world gets
// a random prefix, and the ids end in a number, so inside one world they sort
// like the SPEC's fixed ids (bay 1 < bay 2, T1 < T2, South < North).
export function newWorld(db: Db, types: ServiceTypes) {
  const prefix = randomBytes(4).toString('hex');
  const id = (n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

  async function place(slot: number, spec: PlaceSpec): Promise<Place> {
    const base = slot * 1000;
    const dealershipId = await insertDealership(db, {
      id: id(base),
      name: spec.name,
      timeZone: spec.timeZone ?? 'Europe/London',
      hours: spec.hours ?? NORTH_HOURS,
    });
    const bays: string[] = [];
    for (let n = 1; n <= spec.bays; n++) {
      bays.push(await insertBay(db, { dealershipId, id: id(base + 100 + n), name: `Bay ${n}` }));
    }
    const technicians: string[] = [];
    for (const [i, skills] of spec.technicians.entries()) {
      technicians.push(
        await insertTechnician(db, {
          dealershipId,
          id: id(base + 200 + i + 1),
          name: `T${i + 1}`,
          skills,
        }),
      );
    }
    return { id: dealershipId, bays, technicians };
  }

  // An existing booking as a raw row. It uses its own new car unless the case
  // says which car, so it holds only the bay and technician named.
  async function existing(row: {
    place: Place;
    bay: string;
    technician: string;
    start: Date;
    end: Date;
    car?: Car;
    serviceTypeId?: string;
    status?: AppointmentStatus;
  }): Promise<string> {
    const car = row.car ?? (await insertCustomerWithVehicle(db));
    return insertAppointment(db, {
      dealershipId: row.place.id,
      serviceTypeId: row.serviceTypeId ?? types.oil,
      customerId: car.customerId,
      vehicleId: car.vehicleId,
      serviceBayId: row.bay,
      technicianId: row.technician,
      startsAt: row.start,
      endsAt: row.end,
      status: row.status ?? 'confirmed',
    });
  }

  return { id, place, existing, car: () => insertCustomerWithVehicle(db) };
}

// An OIL request for this car at this place, unless overridden.
export function ask(
  types: ServiceTypes,
  place: Place,
  car: Car,
  startTime: Date,
  extra: Partial<BookingRequest> = {},
): BookingRequest {
  return {
    dealershipId: place.id,
    serviceTypeId: types.oil,
    customerId: car.customerId,
    vehicleId: car.vehicleId,
    startTime,
    preferredTechnicianId: null,
    ...extra,
  };
}

// Counts results by what came back: 'created', the error code, or
// 'contended:<reason>'. Handy for "exactly one created, nineteen 409s".
export function tally(results: BookingResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of results) {
    const key =
      r.kind === 'rejected' ? r.code : r.kind === 'contended' ? `contended:${r.reason}` : r.kind;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// Pairs of active appointments that overlap in time and share a bay, a
// technician or a vehicle, anywhere in the database. Must always be 0. This
// is written straight against the table, so it doesn't trust the service or
// the constraints.
export async function countOverlaps(db: Db): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    SELECT count(*) AS n
    FROM appointments a
    JOIN appointments b ON a.id < b.id
    WHERE a.status <> 'cancelled'
      AND b.status <> 'cancelled'
      AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')
      AND (
        a.service_bay_id = b.service_bay_id
        OR a.technician_id = b.technician_id
        OR a.vehicle_id = b.vehicle_id
      )
  `.execute(db);
  return Number(rows[0]!.n);
}

export async function countRows(
  db: Db,
  where: { dealershipId?: string; vehicleId?: string; technicianId?: string },
): Promise<number> {
  let query = db.selectFrom('appointments').select((eb) => eb.fn.countAll<string>().as('n'));
  if (where.dealershipId) query = query.where('dealership_id', '=', where.dealershipId);
  if (where.vehicleId) query = query.where('vehicle_id', '=', where.vehicleId);
  if (where.technicianId) query = query.where('technician_id', '=', where.technicianId);
  const result = await query.executeTakeFirstOrThrow();
  return Number(result.n);
}
