import { DateTime } from 'luxon';
import { seed, SEED_DEALERSHIP_IDS } from '../../src/db/seed.js';
import type { Database } from '../../src/db/types.js';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';

// The seed is what a reviewer sees after `docker compose up`, so it has to be
// realistic, and it runs on every start, so running it twice must be harmless.

const TABLES: (keyof Database)[] = [
  'dealerships',
  'opening_hours',
  'service_bays',
  'skills',
  'technicians',
  'technician_skills',
  'service_types',
  'customers',
  'vehicles',
  'appointments',
];

async function countRows(tdb: TestDatabase): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const result = await tdb.db
      .selectFrom(table)
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    counts[table] = Number(result.n);
  }
  return counts;
}

describe('seed', () => {
  // Monday 1 March 2027 09:00 UTC, the same "now" as the spec's shared setup
  const now = new Date('2027-03-01T09:00:00Z');
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createTestDatabase();
  });

  afterAll(async () => {
    await tdb?.destroy();
  });

  it('runs twice without error and the second run adds nothing', async () => {
    await seed(tdb.db, now);
    const first = await countRows(tdb);

    // A restart a few minutes later on the same day, like a second
    // `docker compose up`, must not add anything either
    await seed(tdb.db, new Date('2027-03-01T09:05:00Z'));
    const second = await countRows(tdb);

    expect(first.dealerships).toBeGreaterThan(0);
    expect(first.appointments).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  it('has three dealerships with fixed ids, in London, Sydney and Tokyo', async () => {
    await seed(tdb.db, now);
    const rows = await tdb.db
      .selectFrom('dealerships')
      .select(['id', 'time_zone'])
      .orderBy('id')
      .execute();

    expect(rows).toEqual([
      { id: SEED_DEALERSHIP_IDS.london, time_zone: 'Europe/London' },
      { id: SEED_DEALERSHIP_IDS.sydney, time_zone: 'Australia/Sydney' },
      { id: SEED_DEALERSHIP_IDS.tokyo, time_zone: 'Asia/Tokyo' },
    ]);
  });

  it('gives every dealership weekday and Saturday hours, a few bays and some technicians', async () => {
    await seed(tdb.db, now);
    for (const dealershipId of Object.values(SEED_DEALERSHIP_IDS)) {
      const hours = await tdb.db
        .selectFrom('opening_hours')
        .select('iso_weekday')
        .where('dealership_id', '=', dealershipId)
        .orderBy('iso_weekday')
        .execute();
      // Monday to Saturday at least (Sunday is up to the seed)
      expect(hours.map((h) => h.iso_weekday)).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6]));

      const bays = await tdb.db
        .selectFrom('service_bays')
        .select('id')
        .where('dealership_id', '=', dealershipId)
        .execute();
      expect(bays.length).toBeGreaterThanOrEqual(2);

      const techs = await tdb.db
        .selectFrom('technicians')
        .select('id')
        .where('dealership_id', '=', dealershipId)
        .execute();
      expect(techs.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('has technicians with one skill and technicians with several', async () => {
    await seed(tdb.db, now);
    const perTech = await tdb.db
      .selectFrom('technician_skills')
      .select((eb) => ['technician_id', eb.fn.countAll<string>().as('n')])
      .groupBy('technician_id')
      .execute();
    const skillCounts = perTech.map((r) => Number(r.n));

    expect(skillCounts).toContain(1);
    expect(skillCounts.some((n) => n > 1)).toBe(true);
  });

  it('has four or five service types with different durations', async () => {
    await seed(tdb.db, now);
    const types = await tdb.db
      .selectFrom('service_types')
      .select(['duration_minutes', 'required_skill_code'])
      .execute();

    expect(types.length).toBeGreaterThanOrEqual(4);
    expect(types.length).toBeLessThanOrEqual(5);
    expect(new Set(types.map((t) => t.duration_minutes)).size).toBeGreaterThan(1);
    expect(new Set(types.map((t) => t.required_skill_code)).size).toBeGreaterThan(1);
  });

  it('has a handful of customers, each with a vehicle', async () => {
    await seed(tdb.db, now);
    const customers = await tdb.db.selectFrom('customers').select('id').execute();
    const owners = await tdb.db.selectFrom('vehicles').select('customer_id').distinct().execute();

    expect(customers.length).toBeGreaterThanOrEqual(3);
    expect(owners.length).toBe(customers.length);
  });

  it('books the next weekday after now at the London dealership, all confirmed and in the future', async () => {
    await seed(tdb.db, now);
    const rows = await tdb.db
      .selectFrom('appointments')
      .select(['dealership_id', 'starts_at', 'status'])
      .execute();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.dealership_id).toBe(SEED_DEALERSHIP_IDS.london);
      expect(row.status).toBe('confirmed');
      expect(row.starts_at.getTime()).toBeGreaterThan(now.getTime());
      // Monday 1 March, so the busy day is Tuesday 2 March in London
      expect(DateTime.fromJSDate(row.starts_at).setZone('Europe/London').toISODate()).toBe(
        '2027-03-02',
      );
    }
  });
});

describe('seed on a Friday', () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createTestDatabase();
  });

  afterAll(async () => {
    await tdb?.destroy();
  });

  it('puts the busy day on the following Monday, not on the weekend', async () => {
    // Friday 5 March 2027 15:00 UTC
    await seed(tdb.db, new Date('2027-03-05T15:00:00Z'));
    const rows = await tdb.db.selectFrom('appointments').select('starts_at').execute();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(DateTime.fromJSDate(row.starts_at).setZone('Europe/London').toISODate()).toBe(
        '2027-03-08',
      );
    }
  });
});
