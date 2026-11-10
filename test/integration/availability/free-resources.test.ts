import { sql, type Transaction } from 'kysely';
import type { Database } from '../../../src/db/types.js';
import {
  findFreeResources,
  freeBaysQuery,
  freeTechniciansQuery,
  type FreeResourcesQuery,
} from '../../../src/availability/free-resources.js';
import {
  insertAppointment,
  insertBay,
  insertCustomerWithVehicle,
  insertDealership,
  insertServiceType,
  insertTechnician,
} from '../../support/fixtures.js';
import { createTestDatabase, type TestDatabase } from '../../support/test-database.js';
import { inRolledBackTransaction } from './helpers.js';

// The availability read on its own: which bays and which qualified
// technicians at one dealership are free for a range. Each test runs in a
// transaction that is rolled back, so the fixed UUIDs below can be reused.
//
// Fixed UUIDs that sort in name order (SPEC "Shared setup"): bay 1 < bay 2,
// T1 < T2, TA < TB. South's ids sort before North's on purpose, so a read that
// forgets the dealership filter would put them first.

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

const NORTH = id(901);
const SOUTH = id(902);
const BAY1 = id(1);
const BAY2 = id(2);
const BAY3 = id(3);
const SOUTH_BAY = id(0);
const T1 = id(101);
const T2 = id(102);
const T3 = id(103);
const SOUTH_TECH = id(100);
const TA = id(201);
const TB = id(202);
const TC = id(203);
const TD = id(204);

// Tue 9 March 2027. London is on UTC that day, so local time = Z.
const at = (hhmm: string): Date => new Date(`2027-03-09T${hhmm}:00Z`);

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase();
});

afterAll(async () => {
  await tdb?.destroy();
});

type Trx = Transaction<Database>;

// North with bays 1 and 2 and T1 and T2 (OIL_SERVICE only), plus a way to add
// an existing booking on any bay and technician with a car of its own.
async function north(trx: Trx) {
  await insertDealership(trx, { id: NORTH, name: 'North' });
  await insertBay(trx, { dealershipId: NORTH, id: BAY1, name: 'Bay 1' });
  await insertBay(trx, { dealershipId: NORTH, id: BAY2, name: 'Bay 2' });
  await insertTechnician(trx, { dealershipId: NORTH, id: T1, name: 'T1', skills: ['OIL_SERVICE'] });
  await insertTechnician(trx, { dealershipId: NORTH, id: T2, name: 'T2', skills: ['OIL_SERVICE'] });
  return { book: bookingHelper(trx, NORTH) };
}

function bookingHelper(trx: Trx, dealershipId: string) {
  return async (row: {
    bay: string;
    tech: string;
    from: string;
    to: string;
    status?: 'confirmed' | 'cancelled';
  }): Promise<void> => {
    const serviceTypeId = await insertServiceType(trx);
    const car = await insertCustomerWithVehicle(trx);
    await insertAppointment(trx, {
      dealershipId,
      serviceTypeId,
      customerId: car.customerId,
      vehicleId: car.vehicleId,
      serviceBayId: row.bay,
      technicianId: row.tech,
      startsAt: at(row.from),
      endsAt: at(row.to),
      status: row.status ?? 'confirmed',
    });
  };
}

function query(from: string, to: string, skillCode = 'OIL_SERVICE'): FreeResourcesQuery {
  return { dealershipId: NORTH, skillCode, range: { start: at(from), end: at(to) } };
}

describe('findFreeResources', () => {
  it('returns every bay and every qualified technician when nothing is booked', async () => {
    await inRolledBackTransaction(tdb.db, async (trx) => {
      await north(trx);
      const free = await findFreeResources(trx, query('09:00', '10:00'));
      expect(free).toEqual({ bayIds: [BAY1, BAY2], technicianIds: [T1, T2] });
    });
  });

  // An existing booking on bay 1 with T1 from 09:00 to 10:00, and every way a
  // range can overlap it.
  it.each([
    ['overlaps its end', '09:30', '10:30'],
    ['overlaps its start', '08:30', '09:30'],
    ['is the same range', '09:00', '10:00'],
    ['sits inside it', '09:15', '09:45'],
    ['contains it', '08:00', '11:00'],
  ])('leaves out the bay and technician of a booking when the range %s', async (_, from, to) => {
    await inRolledBackTransaction(tdb.db, async (trx) => {
      const { book } = await north(trx);
      await book({ bay: BAY1, tech: T1, from: '09:00', to: '10:00' });
      const free = await findFreeResources(trx, query(from, to));
      expect(free).toEqual({ bayIds: [BAY2], technicianIds: [T2] });
    });
  });

  it('treats the bay and the technician of a booking separately (bay 1 with T2 leaves bay 2 and T1)', async () => {
    await inRolledBackTransaction(tdb.db, async (trx) => {
      const { book } = await north(trx);
      await book({ bay: BAY1, tech: T2, from: '09:00', to: '10:00' });
      const free = await findFreeResources(trx, query('09:30', '10:30'));
      expect(free).toEqual({ bayIds: [BAY2], technicianIds: [T1] });
    });
  });

  // Half open ranges: a booking 09:00 to 10:00 doesn't touch 10:00 to 11:00 or
  // 08:00 to 09:00 (ADR 002).
  it.each([
    ['starts when the booking ends', '10:00', '11:00'],
    ['ends when the booking starts', '08:00', '09:00'],
  ])('counts a bay and technician as free when the range %s', async (_, from, to) => {
    await inRolledBackTransaction(tdb.db, async (trx) => {
      const { book } = await north(trx);
      await book({ bay: BAY1, tech: T1, from: '09:00', to: '10:00' });
      const free = await findFreeResources(trx, query(from, to));
      expect(free).toEqual({ bayIds: [BAY1, BAY2], technicianIds: [T1, T2] });
    });
  });

  it('ignores cancelled bookings', async () => {
    await inRolledBackTransaction(tdb.db, async (trx) => {
      const { book } = await north(trx);
      await book({ bay: BAY1, tech: T1, from: '09:00', to: '10:00', status: 'cancelled' });
      // A confirmed one on the other pair, so the result can't be "everything".
      await book({ bay: BAY2, tech: T2, from: '09:00', to: '10:00' });
      const free = await findFreeResources(trx, query('09:00', '10:00'));
      expect(free).toEqual({ bayIds: [BAY1], technicianIds: [T1] });
    });
  });

  it("never returns another dealership's bays or technicians", async () => {
    await inRolledBackTransaction(tdb.db, async (trx) => {
      await north(trx);
      await insertDealership(trx, { id: SOUTH, name: 'South' });
      await insertBay(trx, { dealershipId: SOUTH, id: SOUTH_BAY, name: 'South bay' });
      await insertTechnician(trx, {
        dealershipId: SOUTH,
        id: SOUTH_TECH,
        name: 'South tech',
        skills: ['OIL_SERVICE'],
      });
      const free = await findFreeResources(trx, query('09:00', '10:00'));
      expect(free).toEqual({ bayIds: [BAY1, BAY2], technicianIds: [T1, T2] });
    });
  });

  it('never returns a technician without the skill', async () => {
    await inRolledBackTransaction(tdb.db, async (trx) => {
      await insertDealership(trx, { id: NORTH, name: 'North' });
      await insertBay(trx, { dealershipId: NORTH, id: BAY1, name: 'Bay 1' });
      await insertTechnician(trx, {
        dealershipId: NORTH,
        id: T1,
        name: 'T1',
        skills: ['OIL_SERVICE'],
      });
      await insertTechnician(trx, { dealershipId: NORTH, id: T2, name: 'T2', skills: ['BRAKES'] });
      await insertTechnician(trx, { dealershipId: NORTH, id: T3, name: 'T3', skills: [] });
      const free = await findFreeResources(trx, query('09:00', '10:00'));
      expect(free).toEqual({ bayIds: [BAY1], technicianIds: [T1] });
    });
  });

  it('orders bays by id, whatever order they were added in', async () => {
    await inRolledBackTransaction(tdb.db, async (trx) => {
      await insertDealership(trx, { id: NORTH, name: 'North' });
      await insertBay(trx, { dealershipId: NORTH, id: BAY3, name: 'Bay 3' });
      await insertBay(trx, { dealershipId: NORTH, id: BAY1, name: 'Bay 1' });
      await insertBay(trx, { dealershipId: NORTH, id: BAY2, name: 'Bay 2' });
      await insertTechnician(trx, {
        dealershipId: NORTH,
        id: T1,
        name: 'T1',
        skills: ['OIL_SERVICE'],
      });
      const free = await findFreeResources(trx, query('09:00', '10:00'));
      expect(free).toEqual({ bayIds: [BAY1, BAY2, BAY3], technicianIds: [T1] });
    });
  });

  // A16: the least flexible technician goes first, so the ones with more
  // skills stay free for jobs only they can do. Ties go to the lowest id. The
  // count is of all the technician's skills, not only the one asked for.
  // Added in reverse order, so the table's own order can't pass the test.
  it('orders technicians by number of skills (fewest first), then by id (A16)', async () => {
    await inRolledBackTransaction(tdb.db, async (trx) => {
      await insertDealership(trx, { id: NORTH, name: 'North' });
      await insertBay(trx, { dealershipId: NORTH, id: BAY1, name: 'Bay 1' });
      await insertTechnician(trx, {
        dealershipId: NORTH,
        id: TD,
        name: 'TD',
        skills: ['OIL_SERVICE', 'BRAKES', 'DIAG'],
      });
      await insertTechnician(trx, {
        dealershipId: NORTH,
        id: TC,
        name: 'TC',
        skills: ['OIL_SERVICE'],
      });
      await insertTechnician(trx, {
        dealershipId: NORTH,
        id: TB,
        name: 'TB',
        skills: ['OIL_SERVICE'],
      });
      await insertTechnician(trx, {
        dealershipId: NORTH,
        id: TA,
        name: 'TA',
        skills: ['OIL_SERVICE', 'BRAKES'],
      });
      const free = await findFreeResources(trx, query('09:00', '10:00'));
      expect(free).toEqual({ bayIds: [BAY1], technicianIds: [TB, TC, TA, TD] });
    });
  });
});

// Every index named anywhere in a JSON plan.
function indexNames(plan: unknown): string[] {
  const names: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'Index Name' && typeof value === 'string') {
          names.push(value);
        } else {
          walk(value);
        }
      }
    }
  };
  walk(plan);
  return names;
}

// This proves the read can use a GiST index behind the exclusion
// constraints. Those indexes are partial (WHERE status <> 'cancelled') and
// built on the expression tstzrange(starts_at, ends_at, '[)'), so the planner
// can only use one when the read has the same expression and a filter that
// implies the same WHERE. On tables this small the planner would pick a
// sequential scan anyway, so it is switched off for the one transaction.
//
// Any of the three indexes counts. All three carry the same range expression
// and WHERE, and when I tried the planned SQL by hand the bay query picked
// appointments_no_vehicle_overlap for a bitmap scan on the range alone. That
// still proves the read matches the constraint, which is the point. A read
// written with a different range expression or without the status filter
// can't use any of the three. Please don't tighten this to one named index.
// Which of the three the planner picks depends on its cost guesses, so that
// test would be flaky.
//
// The plan comes from the query builders findFreeResources is meant to run,
// not a copy, and each test also checks the builder returns the same ids as
// findFreeResources, so the two can't drift apart.
const EXCLUSION_INDEX = /^appointments_no_(bay|technician|vehicle)_overlap$/;

interface ExplainableQuery {
  explain(format: 'json'): Promise<unknown[]>;
  execute(): Promise<{ id: string }[]>;
}

describe('the overlap part of the read can use an exclusion constraint index', () => {
  async function explainWithoutSeqScan(
    build: (trx: Trx, q: FreeResourcesQuery) => ExplainableQuery,
    pick: 'bayIds' | 'technicianIds',
  ): Promise<{ names: string[]; builderIds: string[]; readIds: string[] }> {
    let result = { names: [] as string[], builderIds: [] as string[], readIds: [] as string[] };
    await inRolledBackTransaction(tdb.db, async (trx) => {
      const { book } = await north(trx);
      await book({ bay: BAY1, tech: T1, from: '09:00', to: '10:00' });
      await book({ bay: BAY2, tech: T2, from: '11:00', to: '12:00' });
      const q = query('09:30', '10:30');
      const rows = await build(trx, q).execute();
      const free = await findFreeResources(trx, q);
      await sql`set local enable_seqscan = off`.execute(trx);
      const plan = await build(trx, q).explain('json');
      result = { names: indexNames(plan), builderIds: rows.map((r) => r.id), readIds: free[pick] };
    });
    return result;
  }

  it('the bay query uses an exclusion constraint index and returns what findFreeResources returns', async () => {
    const { names, builderIds, readIds } = await explainWithoutSeqScan(freeBaysQuery, 'bayIds');
    expect(names).toContainEqual(expect.stringMatching(EXCLUSION_INDEX));
    expect(builderIds).toEqual([BAY2]);
    expect(readIds).toEqual(builderIds);
  });

  it('the technician query uses an exclusion constraint index and returns what findFreeResources returns', async () => {
    const { names, builderIds, readIds } = await explainWithoutSeqScan(
      freeTechniciansQuery,
      'technicianIds',
    );
    expect(names).toContainEqual(expect.stringMatching(EXCLUSION_INDEX));
    expect(builderIds).toEqual([T2]);
    expect(readIds).toEqual(builderIds);
  });
});
