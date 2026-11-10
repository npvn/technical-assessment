import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { createDatabase } from './database.js';
import type { Database } from './types.js';

// Seed data for a local run and the README's cURL examples. Every row has a
// fixed id and goes in with ON CONFLICT DO NOTHING, so running it again (every
// `docker compose up` does) adds nothing. That also means a rerun on a later
// day keeps the first busy day. `docker compose down -v` starts fresh.
//
// All names, emails and VINs are made up.

// Fixed ids, so the cURL examples in the README work on any fresh install.
export const SEED_DEALERSHIP_IDS = {
  london: '11111111-1111-4111-8111-111111111111',
  sydney: '22222222-2222-4222-8222-222222222222',
  tokyo: '33333333-3333-4333-8333-333333333333',
} as const;

// Builds a valid v4 style uuid from a readable prefix and a number, for
// example id('ba', 101) is ba000000-0000-4000-8000-000000000101.
function id(prefix: string, n: number): string {
  return `${prefix.padEnd(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const SKILLS = [
  { code: 'OIL_SERVICE', name: 'Oil service' },
  { code: 'BRAKES', name: 'Brakes' },
  { code: 'DIAG', name: 'Diagnostics' },
  { code: 'TYRES', name: 'Tyres' },
  { code: 'AIRCON', name: 'Air conditioning' },
];

const SERVICE_TYPES = {
  oil: {
    id: id('5e', 1),
    code: 'OIL',
    name: 'Oil and filter change',
    duration_minutes: 60,
    required_skill_code: 'OIL_SERVICE',
  },
  brakes: {
    id: id('5e', 2),
    code: 'BRAKES',
    name: 'Brake pads and discs',
    duration_minutes: 90,
    required_skill_code: 'BRAKES',
  },
  diag: {
    id: id('5e', 3),
    code: 'DIAG',
    name: 'Full diagnostic check',
    duration_minutes: 180,
    required_skill_code: 'DIAG',
  },
  tyres: {
    id: id('5e', 4),
    code: 'TYRES',
    name: 'Tyre change',
    duration_minutes: 45,
    required_skill_code: 'TYRES',
  },
  aircon: {
    id: id('5e', 5),
    code: 'AIRCON',
    name: 'Air conditioning service',
    duration_minutes: 30,
    required_skill_code: 'AIRCON',
  },
};

type Hours = { iso_weekday: number; opens_at: string; closes_at: string }[];

function weekHours(weekday: [string, string], saturday: [string, string]): Hours {
  return [
    ...[1, 2, 3, 4, 5].map((iso_weekday) => ({
      iso_weekday,
      opens_at: weekday[0],
      closes_at: weekday[1],
    })),
    { iso_weekday: 6, opens_at: saturday[0], closes_at: saturday[1] },
  ];
}

// London has daylight saving, Sydney has it the other way round (southern
// summer), Tokyo has none. Between them they cover the time zone cases.
const DEALERSHIPS = [
  {
    id: SEED_DEALERSHIP_IDS.london,
    name: 'London Central Service',
    time_zone: 'Europe/London',
    hours: weekHours(['08:00', '17:30'], ['09:00', '13:00']),
    bays: 4,
    technicians: [
      { name: 'Alice Moreno', skills: ['OIL_SERVICE'] },
      { name: 'Ben Okafor', skills: ['OIL_SERVICE', 'BRAKES'] },
      { name: 'Chloe Park', skills: ['BRAKES', 'DIAG', 'TYRES'] },
      { name: 'Dev Sharma', skills: ['TYRES', 'AIRCON'] },
    ],
  },
  {
    id: SEED_DEALERSHIP_IDS.sydney,
    name: 'Sydney Harbour Motors',
    time_zone: 'Australia/Sydney',
    hours: weekHours(['08:00', '17:00'], ['08:00', '12:00']),
    bays: 2,
    technicians: [
      { name: 'Ella Nguyen', skills: ['OIL_SERVICE', 'TYRES'] },
      { name: 'Finn Walsh', skills: ['BRAKES'] },
      { name: 'Grace Lee', skills: ['DIAG', 'AIRCON', 'OIL_SERVICE'] },
    ],
  },
  {
    id: SEED_DEALERSHIP_IDS.tokyo,
    name: 'Tokyo Bay Auto',
    time_zone: 'Asia/Tokyo',
    hours: weekHours(['09:00', '18:00'], ['09:00', '14:00']),
    bays: 3,
    technicians: [
      { name: 'Haruto Sato', skills: ['OIL_SERVICE'] },
      { name: 'Yui Tanaka', skills: ['OIL_SERVICE', 'BRAKES', 'DIAG'] },
      { name: 'Kenji Ito', skills: ['TYRES', 'AIRCON'] },
    ],
  },
];

const CUSTOMERS = [
  { name: 'Olivia Example', make: 'Toyota', model: 'Corolla', year: 2019 },
  { name: 'Noah Sample', make: 'Ford', model: 'Focus', year: 2017 },
  { name: 'Amelia Testwell', make: 'Volkswagen', model: 'Golf', year: 2021 },
  { name: 'Leo Placeholder', make: 'Honda', model: 'Civic', year: 2020 },
  { name: 'Isla Demo', make: 'BMW', model: '320d', year: 2018 },
  { name: 'Oscar Mock', make: 'Kia', model: 'Ceed', year: 2022 },
];

// Dealership number (1 London, 2 Sydney, 3 Tokyo) and position give each bay
// and technician its id, for example London's bay 2 is ba000000-...-000000000102.
const bayId = (dealership: number, n: number) => id('ba', dealership * 100 + n);
const technicianId = (dealership: number, n: number) => id('7e', dealership * 100 + n);
const customerId = (n: number) => id('c0', n);
const vehicleId = (n: number) => id('0e', n);

// The busy day at London, about half of the bay time taken. Bay, technician
// and customer are 1 based positions in the lists above. Every technician has
// the skill the service needs and nothing overlaps on a bay, technician or car.
const BUSY_DAY: {
  bay: number;
  tech: number;
  service: keyof typeof SERVICE_TYPES;
  start: string;
  customer: number;
}[] = [
  { bay: 1, tech: 1, service: 'oil', start: '08:00', customer: 1 },
  { bay: 1, tech: 1, service: 'oil', start: '09:00', customer: 2 },
  { bay: 2, tech: 2, service: 'brakes', start: '08:00', customer: 3 },
  { bay: 3, tech: 3, service: 'diag', start: '09:00', customer: 4 },
  { bay: 2, tech: 2, service: 'oil', start: '10:00', customer: 5 },
  { bay: 4, tech: 4, service: 'tyres', start: '13:00', customer: 6 },
  { bay: 1, tech: 1, service: 'oil', start: '14:00', customer: 1 },
  { bay: 3, tech: 3, service: 'brakes', start: '13:00', customer: 2 },
  { bay: 4, tech: 4, service: 'aircon', start: '15:30', customer: 3 },
];

// The first Monday to Friday after today's date in the dealership's zone.
function nextWeekday(now: Date, zone: string): DateTime {
  let day = DateTime.fromJSDate(now).setZone(zone).startOf('day').plus({ days: 1 });
  while (day.weekday > 5) {
    day = day.plus({ days: 1 });
  }
  return day;
}

export async function seed(db: Kysely<Database>, now: Date): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('skills')
      .values(SKILLS)
      .onConflict((oc) => oc.doNothing())
      .execute();
    await trx
      .insertInto('service_types')
      .values(Object.values(SERVICE_TYPES))
      .onConflict((oc) => oc.doNothing())
      .execute();

    for (const [index, d] of DEALERSHIPS.entries()) {
      const number = index + 1;
      await trx
        .insertInto('dealerships')
        .values({ id: d.id, name: d.name, time_zone: d.time_zone })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await trx
        .insertInto('opening_hours')
        .values(d.hours.map((h) => ({ dealership_id: d.id, ...h })))
        .onConflict((oc) => oc.doNothing())
        .execute();
      await trx
        .insertInto('service_bays')
        .values(
          Array.from({ length: d.bays }, (_, i) => ({
            id: bayId(number, i + 1),
            dealership_id: d.id,
            name: `Bay ${i + 1}`,
          })),
        )
        .onConflict((oc) => oc.doNothing())
        .execute();
      await trx
        .insertInto('technicians')
        .values(
          d.technicians.map((t, i) => ({
            id: technicianId(number, i + 1),
            dealership_id: d.id,
            name: t.name,
          })),
        )
        .onConflict((oc) => oc.doNothing())
        .execute();
      await trx
        .insertInto('technician_skills')
        .values(
          d.technicians.flatMap((t, i) =>
            t.skills.map((skill_code) => ({
              technician_id: technicianId(number, i + 1),
              skill_code,
            })),
          ),
        )
        .onConflict((oc) => oc.doNothing())
        .execute();
    }

    await trx
      .insertInto('customers')
      .values(
        CUSTOMERS.map((c, i) => ({
          id: customerId(i + 1),
          name: c.name,
          email: `${c.name.split(' ')[0]!.toLowerCase()}@example.com`,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
    await trx
      .insertInto('vehicles')
      .values(
        CUSTOMERS.map((c, i) => ({
          id: vehicleId(i + 1),
          customer_id: customerId(i + 1),
          // 17 characters like a real VIN, but clearly fake
          vin: `SEEDCAR${String(i + 1).padStart(10, '0')}`,
          make: c.make,
          model: c.model,
          year: c.year,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();

    const london = DEALERSHIPS[0]!;
    const day = nextWeekday(now, london.time_zone);
    await trx
      .insertInto('appointments')
      .values(
        BUSY_DAY.map((a, i) => {
          const service = SERVICE_TYPES[a.service];
          const [hour, minute] = a.start.split(':').map(Number);
          const startsAt = day.set({ hour, minute });
          return {
            id: id('a0', i + 1),
            dealership_id: london.id,
            service_type_id: service.id,
            customer_id: customerId(a.customer),
            vehicle_id: vehicleId(a.customer),
            service_bay_id: bayId(1, a.bay),
            technician_id: technicianId(1, a.tech),
            starts_at: startsAt.toJSDate(),
            ends_at: startsAt.plus({ minutes: service.duration_minutes }).toJSDate(),
            status: 'confirmed' as const,
          };
        }),
      )
      // No conflict target, so this also skips a row that would clash with
      // a booking somebody made since the last run, instead of failing.
      .onConflict((oc) => oc.doNothing())
      .execute();
  });
}

// CLI entry: node dist/db/seed.js, with DATABASE_URL set.
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  const db = createDatabase({
    url,
    poolSize: 1,
    statementTimeoutMs: 30_000,
    lockTimeoutMs: 10_000,
  });
  try {
    // The seed is not domain code, it runs once at start up, so the real
    // clock is fine here.
    await seed(db, new Date());
    console.log('seed done');
  } finally {
    await db.destroy();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
